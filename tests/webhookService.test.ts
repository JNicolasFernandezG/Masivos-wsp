import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/database.js';
import { LidRepository } from '../src/repositories/lidRepository.js';
import { MessageRepository } from '../src/repositories/messageRepository.js';
import { EventBus } from '../src/services/eventBus.js';
import type { WahaClient } from '../src/services/wahaClient.js';
import { verifyWahaHmac, WebhookService } from '../src/services/webhookService.js';

function createMockWahaClient(overrides: Partial<WahaClient> = {}): WahaClient {
  return {
    getSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING' }),
    startSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    restartSession: vi.fn().mockResolvedValue(undefined),
    logoutSession: vi.fn().mockResolvedValue(undefined),
    getQrCode: vi.fn().mockResolvedValue({ mimetype: 'image/png', data: '' }),
    requestPairingCode: vi.fn().mockResolvedValue({ code: '1234-5678' }),
    sendText: vi.fn().mockResolvedValue({ id: 'msg-out-1', raw: {} }),
    resolveLidToPhone: vi.fn().mockResolvedValue(null),
    ping: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('webhookService', () => {
  it('verifica firmas HMAC-SHA512 correctamente', () => {
    const secret = 'mi-secreto-webhook';
    const raw = Buffer.from('{"event":"message"}', 'utf8');
    const sig = crypto.createHmac('sha512', secret).update(raw).digest('hex');

    expect(verifyWahaHmac(raw, sig, 'sha512', secret)).toBe(true);
    expect(verifyWahaHmac(raw, 'deadbeef', 'sha512', secret)).toBe(false);
    expect(verifyWahaHmac(raw, sig, 'sha256', secret)).toBe(false);
    expect(verifyWahaHmac(raw, undefined, 'sha512', secret)).toBe(false);
  });

  it('guarda mensajes entrantes, normaliza @s.whatsapp.net a @c.us y deduplica por waha_message_id', async () => {
    const db = createDatabase(':memory:');
    const messageRepo = new MessageRepository(db);
    const lidRepo = new LidRepository(db);
    const eventBus = new EventBus();
    const wahaClient = createMockWahaClient();
    const service = new WebhookService(messageRepo, lidRepo, wahaClient, eventBus);

    const events: string[] = [];
    eventBus.subscribe((ev) => events.push(ev.type));

    const payload = {
      event: 'message',
      session: 'default',
      payload: {
        id: 'wamid-001',
        timestamp: 1763480000,
        from: '5491122334455:0@s.whatsapp.net',
        chatId: '5491122334455@s.whatsapp.net',
        body: 'Hola, recibí el aviso',
        fromMe: false,
        hasMedia: false,
        type: 'chat',
        _data: { notifyName: 'Ana' },
      },
    };

    const first = await service.handleEvent(payload);
    const duplicate = await service.handleEvent({ ...payload, event: 'message.any' });

    expect(first.inserted).toBe(true);
    expect(first.message?.chat_id).toBe('5491122334455@c.us');
    expect(first.message?.sender_name).toBe('Ana');
    expect(duplicate.inserted).toBe(false);
    expect(events).toEqual(['message.received']);
    expect(messageRepo.listMessages()).toHaveLength(1);
    db.close();
  });

  it('resuelve @lid vía API de WAHA y cachea el mapeo en lid_mappings', async () => {
    const db = createDatabase(':memory:');
    const messageRepo = new MessageRepository(db);
    const lidRepo = new LidRepository(db);
    const eventBus = new EventBus();
    const resolveLidToPhone = vi.fn().mockResolvedValue({
      lid: '123456789@lid',
      pn: '5491199887766@c.us',
    });
    const wahaClient = createMockWahaClient({ resolveLidToPhone });
    const service = new WebhookService(messageRepo, lidRepo, wahaClient, eventBus);

    const res1 = await service.handleEvent({
      event: 'message',
      session: 'default',
      payload: {
        id: 'wamid-lid-1',
        timestamp: 1763480001,
        from: '123456789@lid',
        chatId: '123456789@lid',
        body: 'Mensaje desde LID',
        fromMe: false,
      },
    });

    const res2 = await service.handleEvent({
      event: 'message',
      session: 'default',
      payload: {
        id: 'wamid-lid-2',
        timestamp: 1763480002,
        from: '123456789@lid',
        chatId: '123456789@lid',
        body: 'Segundo mensaje LID',
        fromMe: false,
      },
    });

    expect(res1.message?.chat_id).toBe('5491199887766@c.us');
    expect(res1.message?.raw_chat_id).toBe('123456789@lid');
    expect(res2.message?.chat_id).toBe('5491199887766@c.us');
    expect(resolveLidToPhone).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('muestra siempre el último mensaje por timestamp_unix (no por id) y evita duplicados por contenido/timestamp', async () => {
    const db = createDatabase(':memory:');
    const messageRepo = new MessageRepository(db);
    const lidRepo = new LidRepository(db);
    const eventBus = new EventBus();
    const wahaClient = createMockWahaClient();
    const service = new WebhookService(messageRepo, lidRepo, wahaClient, eventBus);

    // 1. Primero se inserta el mensaje entrante MÁS RECIENTE (18:30)
    await service.handleEvent({
      event: 'message',
      session: 'default',
      payload: {
        id: 'wamid-in-newer',
        timestamp: 1764192602,
        from: '5491171393671@c.us',
        chatId: '5491171393671@c.us',
        body: 'A mí me debitan de mí tarjeta',
        fromMe: false,
        _data: { notifyName: 'Rosi' },
      },
    });

    // 2. Después (ej. por sync histórico) se inserta un mensaje saliente MÁS VIEJO (16:31)
    await service.handleEvent({
      event: 'message.any',
      session: 'default',
      payload: {
        id: 'wamid-out-older-1',
        timestamp: 1764185479,
        to: '5491171393671@c.us',
        chatId: '5491171393671@c.us',
        body: 'Usted registra deuda con Asistodo',
        fromMe: true,
      },
    });

    // 3. Mismo mensaje saliente con otro formato de ID en el mismo segundo -> no debe duplicar
    const dup = await service.handleEvent({
      event: 'message.any',
      session: 'default',
      payload: {
        id: 'true_5491171393671@c.us_wamid-out-older-1',
        timestamp: 1764185479,
        to: '5491171393671@c.us',
        chatId: '5491171393671@c.us',
        body: 'Usted registra deuda con Asistodo',
        fromMe: true,
      },
    });
    expect(dup.inserted).toBe(false);

    const convs = messageRepo.listConversations(10);
    expect(convs).toHaveLength(1);
    expect(convs[0].last_direction).toBe('IN');
    expect(convs[0].last_body).toBe('A mí me debitan de mí tarjeta');
    expect(convs[0].last_timestamp).toBe(1764192602);
    expect(convs[0].message_count).toBe(2);
    db.close();
  });
});
