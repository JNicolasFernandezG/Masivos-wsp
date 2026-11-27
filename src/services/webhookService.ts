import crypto from 'node:crypto';
import type { LidRepository } from '../repositories/lidRepository.js';
import type { MessageRepository, StoredMessageRecord } from '../repositories/messageRepository.js';
import type { EventBus } from './eventBus.js';
import { normalizeIncomingJid } from './jidNormalizer.js';
import type { WahaClient } from './wahaClient.js';

export interface WebhookHandleResult {
  handled: boolean;
  event: string;
  inserted?: boolean;
  message?: StoredMessageRecord;
}

export interface WahaSyncResult {
  synced: boolean;
  sessionStatus: string;
  chatsScanned: number;
  importedCount: number;
  importedIncomingCount: number;
}

export function verifyWahaHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  algorithmHeader: string | undefined,
  secret: string
): boolean {
  if (!secret) {
    return true;
  }
  if (!signatureHeader || !algorithmHeader) {
    return false;
  }
  if (algorithmHeader.toLowerCase() !== 'sha512') {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  const receivedBuf = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

function extractAltPhoneJidFromData(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const info = data.Info as Record<string, unknown> | undefined;
  const key = data.key as Record<string, unknown> | undefined;

  const candidates = [
    data.senderPn,
    data.SenderAlt,
    info?.SenderAlt,
    info?.RecipientAlt,
    key?.remoteJidAlt,
    key?.participantAlt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const normalized = normalizeIncomingJid(candidate);
      if (normalized.kind === 'user' && normalized.phoneNumber) {
        return normalized.chatId;
      }
    }
  }
  return null;
}

function extractSenderName(payload: Record<string, unknown>): string | null {
  const data = payload._data as Record<string, unknown> | undefined;
  const info = data?.Info as Record<string, unknown> | undefined;
  const candidates = [
    payload.notifyName,
    data?.notifyName,
    data?.pushName,
    info?.PushName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  if (typeof payload.id === 'string' && payload.id.trim()) {
    return payload.id.trim();
  }
  const idObj = payload.id as Record<string, unknown> | undefined;
  if (typeof idObj?._serialized === 'string' && idObj._serialized.trim()) {
    return idObj._serialized.trim();
  }
  return null;
}

export class WebhookService {
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly lidRepo: LidRepository,
    private readonly wahaClient: WahaClient,
    private readonly eventBus: EventBus
  ) {}

  async resolveChatIdentity(
    session: string,
    rawJid: string,
    data?: Record<string, unknown>
  ): Promise<{ chatId: string; rawChatId: string; phoneNumber: string | null }> {
    const normalized = normalizeIncomingJid(rawJid);
    if (normalized.kind === 'user') {
      return {
        chatId: normalized.chatId,
        rawChatId: normalized.rawChatId,
        phoneNumber: normalized.phoneNumber,
      };
    }

    if (normalized.kind === 'lid') {
      const altFromPayload = extractAltPhoneJidFromData(data);
      if (altFromPayload) {
        const altNorm = normalizeIncomingJid(altFromPayload);
        if (altNorm.phoneNumber) {
          this.lidRepo.upsert(normalized.chatId, altNorm.chatId, altNorm.phoneNumber);
          return {
            chatId: altNorm.chatId,
            rawChatId: normalized.rawChatId,
            phoneNumber: altNorm.phoneNumber,
          };
        }
      }

      const cached = this.lidRepo.findByLid(normalized.chatId);
      if (cached) {
        return {
          chatId: cached.phone_jid,
          rawChatId: normalized.rawChatId,
          phoneNumber: cached.phone_number,
        };
      }

      const resolved = await this.wahaClient.resolveLidToPhone(session, normalized.chatId);
      if (resolved?.pn) {
        const pnNorm = resolved.pn.includes('@')
          ? normalizeIncomingJid(resolved.pn)
          : normalizeIncomingJid(`${resolved.pn}@c.us`);
        if (pnNorm.kind === 'user' && pnNorm.phoneNumber) {
          this.lidRepo.upsert(normalized.chatId, pnNorm.chatId, pnNorm.phoneNumber);
          return {
            chatId: pnNorm.chatId,
            rawChatId: normalized.rawChatId,
            phoneNumber: pnNorm.phoneNumber,
          };
        }
      }
    }

    return {
      chatId: normalized.chatId,
      rawChatId: normalized.rawChatId,
      phoneNumber: normalized.phoneNumber,
    };
  }

  async handleEvent(body: unknown): Promise<WebhookHandleResult> {
    if (!body || typeof body !== 'object') {
      return { handled: false, event: 'invalid' };
    }

    const root = body as Record<string, unknown>;
    const event = typeof root.event === 'string' ? root.event : 'unknown';
    const session = typeof root.session === 'string' ? root.session : 'default';
    const payload =
      root.payload && typeof root.payload === 'object'
        ? (root.payload as Record<string, unknown>)
        : {};

    if (event === 'session.status') {
      this.eventBus.emit('session.status', {
        session,
        status: typeof payload.status === 'string' ? payload.status : 'UNKNOWN',
        payload,
      });
      return { handled: true, event };
    }

    if (event !== 'message' && event !== 'message.any') {
      return { handled: false, event };
    }

    const fromMe = Boolean(payload.fromMe);
    const candidateJid = fromMe
      ? (typeof payload.chatId === 'string' && payload.chatId) ||
        (typeof payload.to === 'string' && payload.to) ||
        (typeof payload.from === 'string' && payload.from) ||
        ''
      : (typeof payload.chatId === 'string' && payload.chatId) ||
        (typeof payload.from === 'string' && payload.from) ||
        '';

    if (!candidateJid) {
      return { handled: false, event };
    }

    const initialNorm = normalizeIncomingJid(candidateJid);
    if (initialNorm.kind === 'broadcast') {
      return { handled: false, event };
    }

    const data =
      payload._data && typeof payload._data === 'object'
        ? (payload._data as Record<string, unknown>)
        : undefined;

    const identity = await this.resolveChatIdentity(session, candidateJid, data);
    const wahaMessageId = extractMessageId(payload);
    const bodyText = typeof payload.body === 'string' ? payload.body : '';
    const messageType = typeof payload.type === 'string' ? payload.type : 'chat';
    const hasMedia = Boolean(payload.hasMedia);
    const ack = typeof payload.ack === 'number' ? payload.ack : null;
    const timestampUnix =
      typeof payload.timestamp === 'number'
        ? payload.timestamp
        : Math.floor(Date.now() / 1000);

    const { record, inserted } = this.messageRepo.saveMessage({
      wahaMessageId,
      sessionName: session,
      eventType: event,
      direction: fromMe ? 'OUT' : 'IN',
      fromMe,
      chatId: identity.chatId,
      rawChatId: identity.rawChatId,
      senderPhone: identity.phoneNumber,
      senderName: extractSenderName(payload),
      body: bodyText,
      messageType,
      hasMedia,
      ack,
      timestampUnix,
      payloadJson: JSON.stringify(root),
    });

    if (inserted) {
      this.eventBus.emit(fromMe ? 'message.sent' : 'message.received', record);
    }

    return {
      handled: true,
      event,
      inserted,
      message: record,
    };
  }

  async syncMessagesFromWaha(
    session: string,
    options: { chatLimit?: number; messagesPerChat?: number } = {}
  ): Promise<WahaSyncResult> {
    if (!this.wahaClient.listChats || !this.wahaClient.getChatMessages) {
      return {
        synced: false,
        sessionStatus: 'UNSUPPORTED',
        chatsScanned: 0,
        importedCount: 0,
        importedIncomingCount: 0,
      };
    }

    const sessionInfo = await this.wahaClient.getSession(session);
    const sessionStatus = sessionInfo?.status ?? 'STOPPED';
    if (sessionStatus !== 'WORKING') {
      return {
        synced: false,
        sessionStatus,
        chatsScanned: 0,
        importedCount: 0,
        importedIncomingCount: 0,
      };
    }

    const chatLimit = Math.max(1, Math.min(100, options.chatLimit ?? 30));
    const messagesPerChat = Math.max(1, Math.min(50, options.messagesPerChat ?? 20));
    const chats = await this.wahaClient.listChats(session, chatLimit);

    let chatsScanned = 0;
    let importedCount = 0;
    let importedIncomingCount = 0;

    for (const chat of chats) {
      const normalizedChat = normalizeIncomingJid(chat.id);
      if (normalizedChat.kind === 'broadcast' || chat.id.endsWith('@newsletter')) {
        continue;
      }

      chatsScanned += 1;
      let rawMessages: Record<string, unknown>[] = [];
      try {
        rawMessages = await this.wahaClient.getChatMessages(session, chat.id, messagesPerChat);
      } catch {
        rawMessages = [];
      }

      if (rawMessages.length === 0 && chat.lastMessage) {
        rawMessages = [chat.lastMessage];
      }

      rawMessages.sort((a, b) => {
        const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
        const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
        return ta - tb;
      });

      for (const rawMsg of rawMessages) {
        const payload: Record<string, unknown> = {
          ...rawMsg,
          chatId:
            typeof rawMsg.chatId === 'string' && rawMsg.chatId.trim()
              ? rawMsg.chatId
              : chat.id,
          notifyName:
            typeof rawMsg.notifyName === 'string' && rawMsg.notifyName.trim()
              ? rawMsg.notifyName
              : chat.name ?? undefined,
        };

        try {
          const res = await this.handleEvent({
            event: 'message.any',
            session,
            payload,
          });
          if (res.inserted) {
            importedCount += 1;
            if (res.message?.direction === 'IN') {
              importedIncomingCount += 1;
            }
          }
        } catch {
          // Ignore individual malformed historical messages during sync
        }
      }
    }

    return {
      synced: true,
      sessionStatus,
      chatsScanned,
      importedCount,
      importedIncomingCount,
    };
  }
}
