import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { LidRepository } from '../repositories/lidRepository.js';
import type { MessageDirection, MessageRepository } from '../repositories/messageRepository.js';
import type { EventBus } from '../services/eventBus.js';
import { normalizeIncomingJid, normalizeOutboundRecipient } from '../services/jidNormalizer.js';
import { WahaApiError, type WahaClient } from '../services/wahaClient.js';

export interface MessageRouteDeps {
  messageRepo: MessageRepository;
  lidRepo: LidRepository;
  wahaClient: WahaClient;
  eventBus: EventBus;
  config: AppConfig;
}

const replySchema = z.object({
  chatId: z.string().trim().min(1, 'El destinatario (chatId) es obligatorio.'),
  text: z.string().trim().min(1, 'El texto del mensaje no puede estar vacío.'),
});

export function createMessageRoutes(deps: MessageRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/api/messages', async (req) => {
      const query = req.query as {
        chatId?: string;
        direction?: string;
        search?: string;
        limit?: string;
      };
      const direction: MessageDirection | undefined =
        query.direction === 'IN' || query.direction === 'OUT'
          ? query.direction
          : undefined;
      const limit = query.limit ? Number(query.limit) : 100;

      return {
        messages: deps.messageRepo.listMessages({
          chatId: query.chatId || undefined,
          direction,
          search: query.search || undefined,
          limit: Number.isFinite(limit) ? limit : 100,
        }),
      };
    });

    fastify.get('/api/conversations', async (req) => {
      const query = req.query as { limit?: string };
      const limit = query.limit ? Number(query.limit) : 50;
      return {
        conversations: deps.messageRepo.listConversations(
          Number.isFinite(limit) ? limit : 50
        ),
      };
    });

    fastify.post('/api/messages/reply', async (req, reply) => {
      const parsed = replySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'Datos inválidos.',
        });
      }

      const rawTarget = parsed.data.chatId;
      let targetChatId = rawTarget;
      let senderPhone: string | null = null;

      if (rawTarget.includes('@')) {
        const norm = normalizeIncomingJid(rawTarget);
        if (norm.kind === 'lid') {
          const cached = deps.lidRepo.findByLid(norm.chatId);
          if (cached) {
            targetChatId = cached.phone_jid;
            senderPhone = cached.phone_number;
          } else {
            targetChatId = norm.chatId;
          }
        } else if (norm.kind === 'user' || norm.kind === 'group') {
          targetChatId = norm.chatId;
          senderPhone = norm.phoneNumber;
        } else {
          return reply.status(400).send({
            ok: false,
            error: `Identificador de chat inválido: ${rawTarget}`,
          });
        }
      } else {
        const out = normalizeOutboundRecipient(rawTarget, deps.config.defaultCountryCode);
        if (!out.ok) {
          return reply.status(400).send({ ok: false, error: out.error });
        }
        targetChatId = out.chatId;
        senderPhone = out.phoneNormalized;
      }

      try {
        const sendResult = await deps.wahaClient.sendText(
          deps.config.wahaSession,
          targetChatId,
          parsed.data.text
        );

        const { record, inserted } = deps.messageRepo.saveMessage({
          wahaMessageId: sendResult.id,
          sessionName: deps.config.wahaSession,
          eventType: 'manual.reply',
          direction: 'OUT',
          fromMe: true,
          chatId: targetChatId,
          rawChatId: rawTarget,
          senderPhone,
          senderName: null,
          body: parsed.data.text,
          messageType: 'chat',
          hasMedia: false,
          ack: 1,
          timestampUnix: Math.floor(Date.now() / 1000),
          payloadJson: JSON.stringify(sendResult.raw ?? {}),
        });

        if (inserted) {
          deps.eventBus.emit('message.sent', record);
        }

        return { ok: true, message: record };
      } catch (err) {
        const status = err instanceof WahaApiError ? err.statusCode : 502;
        return reply.status(status >= 400 ? status : 502).send({
          ok: false,
          error:
            err instanceof Error ? err.message : 'No se pudo enviar la respuesta vía WAHA.',
        });
      }
    });

    fastify.delete('/api/messages/history', async () => {
      const result = deps.messageRepo.clearAllMessages();
      const compacted = result.deletedMessages > 0 ? deps.messageRepo.compact() : false;

      if (result.deletedMessages > 0) {
        deps.eventBus.emit('messages.cleared', result);
      }

      return {
        ok: true,
        ...result,
        compacted,
      };
    });
  };
}
