import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import type { WahaClient } from '../src/services/wahaClient.js';

function createMockWaha(): WahaClient {
  return {
    getSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING', engine: 'GOWS' }),
    startSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    restartSession: vi.fn().mockResolvedValue(undefined),
    logoutSession: vi.fn().mockResolvedValue(undefined),
    getQrCode: vi.fn().mockResolvedValue({ mimetype: 'image/png', data: 'abc' }),
    requestPairingCode: vi.fn().mockResolvedValue({ code: 'ABCD-1234' }),
    sendText: vi.fn().mockResolvedValue({ id: 'waha-reply-99', raw: { id: 'waha-reply-99' } }),
    resolveLidToPhone: vi.fn().mockResolvedValue(null),
    ping: vi.fn().mockResolvedValue(true),
  };
}

describe('HTTP API integration', () => {
  it('crea lotes vía API REST, recibe webhooks HMAC, consulta conversaciones y responde', async () => {
    const hmacSecret = 'hmac-test-key';
    const adminToken = 'admin-secret-token';
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      WAHA_WEBHOOK_HMAC_KEY: hmacSecret,
      ADMIN_API_TOKEN: adminToken,
      WORKER_SUGGESTED_BATCH_SIZE: '25',
      WORKER_MAX_BATCH_SIZE: '30',
      WORKER_ENABLED: 'false',
    });

    const db = createDatabase(':memory:');
    const wahaClient = createMockWaha();
    const { app } = buildApp({ config, db, wahaClient, logger: false });

    // Health es público
    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().ok).toBe(true);
    expect(healthRes.json().config.authRequired).toBe(true);

    // Sin ADMIN_API_TOKEN debe devolver 401
    const unauthRes = await app.inject({ method: 'GET', url: '/api/batches' });
    expect(unauthRes.statusCode).toBe(401);

    // Crear lote con formato API REST
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/batches',
      headers: { 'x-admin-token': adminToken },
      payload: {
        name: 'Cobranzas Noviembre',
        template: 'Hola {{nombre}}, tu gestión {{nro}} por {{monto}} está disponible.',
        messages: [
          {
            to: '5491112345678',
            variables: { nombre: 'Ana', nro: 'G-1', monto: '$10.000' },
          },
          {
            to: '5491187654321',
            variables: { nombre: 'Pedro', nro: 'G-2', monto: '$15.000' },
          },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdBody = createRes.json();
    expect(createdBody.batch.total_count).toBe(2);

    // Webhook HMAC inválido -> 401
    const badWebhook = await app.inject({
      method: 'POST',
      url: '/api/webhooks/waha',
      headers: {
        'content-type': 'application/json',
        'x-webhook-hmac': 'invalid',
        'x-webhook-hmac-algorithm': 'sha512',
      },
      payload: JSON.stringify({ event: 'message', session: 'default', payload: {} }),
    });
    expect(badWebhook.statusCode).toBe(401);

    // Webhook HMAC válido -> 200 y guarda mensaje entrante
    const rawWebhookPayload = JSON.stringify({
      event: 'message',
      session: 'default',
      payload: {
        id: 'msg-in-55',
        timestamp: 1763481000,
        from: '5491112345678@s.whatsapp.net',
        chatId: '5491112345678@s.whatsapp.net',
        body: 'Gracias, ya transferí',
        fromMe: false,
        _data: { notifyName: 'Ana' },
      },
    });
    const validHmac = crypto
      .createHmac('sha512', hmacSecret)
      .update(Buffer.from(rawWebhookPayload, 'utf8'))
      .digest('hex');

    const okWebhook = await app.inject({
      method: 'POST',
      url: '/api/webhooks/waha',
      headers: {
        'content-type': 'application/json',
        'x-webhook-hmac': validHmac,
        'x-webhook-hmac-algorithm': 'sha512',
      },
      payload: rawWebhookPayload,
    });
    expect(okWebhook.statusCode).toBe(200);
    expect(okWebhook.json().inserted).toBe(true);

    // Responder desde el panel/API
    const replyRes = await app.inject({
      method: 'POST',
      url: '/api/messages/reply',
      headers: { 'x-admin-token': adminToken },
      payload: {
        chatId: '5491112345678@s.whatsapp.net',
        text: 'Recibido Ana, ¡muchas gracias!',
      },
    });
    expect(replyRes.statusCode).toBe(200);
    expect(wahaClient.sendText).toHaveBeenCalledWith(
      'default',
      '5491112345678@c.us',
      'Recibido Ana, ¡muchas gracias!'
    );

    const convRes = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'x-admin-token': adminToken },
    });
    expect(convRes.statusCode).toBe(200);
    expect(convRes.json().conversations[0].chat_id).toBe('5491112345678@c.us');
    expect(convRes.json().conversations[0].message_count).toBe(2);

    // Pausar, reanudar y cancelar lote
    const pauseRes = await app.inject({
      method: 'POST',
      url: `/api/batches/${createdBody.batch.id}/pause`,
      headers: { 'x-admin-token': adminToken },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().batch.status).toBe('PAUSADO');

    const resumeRes = await app.inject({
      method: 'POST',
      url: `/api/batches/${createdBody.batch.id}/resume`,
      headers: { 'x-admin-token': adminToken },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().batch.status).toBe('PENDIENTE');

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/batches/${createdBody.batch.id}/cancel`,
      headers: { 'x-admin-token': adminToken },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().batch.status).toBe('CANCELADO');
    expect(cancelRes.json().batch.cancelled_count).toBe(2);

    // Descarga de plantilla CSV y carga multipart + UI estática
    const sampleRes = await app.inject({
      method: 'GET',
      url: '/api/batches/sample.csv',
      headers: { 'x-admin-token': adminToken },
    });
    expect(sampleRes.statusCode).toBe(200);
    expect(sampleRes.body).toContain('telefono;nombre;nro_gestion');

    const boundary = '----masivosTestBoundary';
    const csvPayload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      `telefono;nombre\r\n5491133445566;Lucia\r\n` +
      `--${boundary}--\r\n`;

    const parseRes = await app.inject({
      method: 'POST',
      url: '/api/batches/parse-file',
      headers: {
        'x-admin-token': adminToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: csvPayload,
    });
    expect(parseRes.statusCode).toBe(200);
    expect(parseRes.json().rows).toEqual([{ telefono: '5491133445566', nombre: 'Lucia' }]);

    const indexRes = await app.inject({ method: 'GET', url: '/' });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).toContain('Masivos-wsp');

    await app.close();
    db.close();
  });

  it('rechaza lotes que exceden WORKER_MAX_BATCH_SIZE', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      WORKER_SUGGESTED_BATCH_SIZE: '2',
      WORKER_MAX_BATCH_SIZE: '2',
      WORKER_ENABLED: 'false',
    });
    const db = createDatabase(':memory:');
    const { app } = buildApp({
      config,
      db,
      wahaClient: createMockWaha(),
      logger: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: {
        name: 'Excedido',
        messages: [
          { to: '5491111111111', text: 'Uno' },
          { to: '5491122222222', text: 'Dos' },
          { to: '5491133333333', text: 'Tres' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('excede el máximo permitido');

    await app.close();
    db.close();
  });
});
