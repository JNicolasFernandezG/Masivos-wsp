import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
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
      WORKER_CHUNK_SIZE: '25',
      WORKER_SUGGESTED_BATCH_SIZE: '25',
      WORKER_MAX_BATCH_SIZE: '1000',
      WORKER_ENABLED: 'false',
    });

    const db = createDatabase(':memory:');
    const wahaClient = createMockWaha();
    const { app } = buildApp({ config, db, wahaClient, logger: false });

    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({ ok: true, db: 'ok', authRequired: true });
    expect(healthRes.json().config).toBeUndefined();
    expect(healthRes.json().worker).toBeUndefined();
    expect(healthRes.json().wahaReachable).toBeUndefined();

    const healthAuthRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-admin-token': adminToken },
    });
    expect(healthAuthRes.statusCode).toBe(200);
    expect(healthAuthRes.json().ok).toBe(true);
    expect(healthAuthRes.json().config.authRequired).toBe(true);
    expect(healthAuthRes.json().config.defaultMessageTemplate).toContain('Asistodo');

    // Sin ADMIN_API_TOKEN debe devolver 401
    const unauthRes = await app.inject({ method: 'GET', url: '/api/batches' });
    expect(unauthRes.statusCode).toBe(401);

    // Flujo de login simple contra ADMIN_API_TOKEN (.env)
    const statusBefore = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json()).toEqual({ authRequired: true, authenticated: false });

    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'clave-incorrecta' },
    });
    expect(badLogin.statusCode).toBe(401);

    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: adminToken },
    });
    expect(goodLogin.statusCode).toBe(200);
    const setCookie = goodLogin.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : String(setCookie).split(';')[0];
    expect(cookieHeader).toContain('masivos_session=');

    const batchesWithCookie = await app.inject({
      method: 'GET',
      url: '/api/batches',
      headers: { cookie: cookieHeader },
    });
    expect(batchesWithCookie.statusCode).toBe(200);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookieHeader },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(String(logoutRes.headers['set-cookie'])).toContain('Max-Age=0');

    // Crear lote usando plantilla por defecto de Asistodo (sin enviar template explícito)
    // Incluye un teléfono duplicado que debe omitirse automáticamente
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/batches',
      headers: { 'x-admin-token': adminToken },
      payload: {
        name: 'Deudas Asistodo',
        rows: [
          { TELEFONO: 'tel:01144045549', NOMBRE: 'Ana Pérez', OBSERVACION: 'Aviso 1' },
          { TELEFONO: 'tel:0239615545631', NOMBRE: 'Carlos Gómez', OBSERVACION: '' },
          { TELEFONO: '0239615545631', NOMBRE: 'Carlos Gómez', OBSERVACION: 'Duplicado' },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdBody = createRes.json();
    expect(createdBody.batch.total_count).toBe(2);
    expect(createdBody.skippedDuplicateCount).toBe(1);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/batches/${createdBody.batch.id}`,
      headers: { 'x-admin-token': adminToken },
    });
    expect(detailRes.json().messages[0].chat_id).toBe('5491144045549@c.us');
    expect(detailRes.json().messages[0].rendered_text).toBe(
      'Usted, Ana Pérez registra deuda con Asistodo, regularice enviando un mensaje de whatsapp al 1176560109'
    );

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
        from: '5491144045549@s.whatsapp.net',
        chatId: '5491144045549@s.whatsapp.net',
        body: 'Gracias, ya regularizo',
        fromMe: false,
        _data: { notifyName: 'Ana Pérez' },
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

    const replyRes = await app.inject({
      method: 'POST',
      url: '/api/messages/reply',
      headers: { 'x-admin-token': adminToken },
      payload: {
        chatId: '5491144045549@s.whatsapp.net',
        text: 'Recibido Ana, ¡muchas gracias!',
      },
    });
    expect(replyRes.statusCode).toBe(200);
    expect(wahaClient.sendText).toHaveBeenCalledWith(
      'default',
      '5491144045549@c.us',
      'Recibido Ana, ¡muchas gracias!'
    );

    const convRes = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'x-admin-token': adminToken },
    });
    expect(convRes.statusCode).toBe(200);
    expect(convRes.json().conversations[0].chat_id).toBe('5491144045549@c.us');
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

    // Plantilla CSV eliminada (cae en :id como inválido) y plantilla XLSX solo con encabezados vacíos
    const sampleCsvRes = await app.inject({
      method: 'GET',
      url: '/api/batches/sample.csv',
      headers: { 'x-admin-token': adminToken },
    });
    expect(sampleCsvRes.statusCode).toBe(400);

    const sampleXlsxRes = await app.inject({
      method: 'GET',
      url: '/api/batches/sample.xlsx',
      headers: { 'x-admin-token': adminToken },
    });
    expect(sampleXlsxRes.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(sampleXlsxRes.rawPayload as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    expect(sheet.rowCount).toBe(1);
    expect([
      sheet.getRow(1).getCell(1).value,
      sheet.getRow(1).getCell(2).value,
      sheet.getRow(1).getCell(3).value,
    ]).toEqual(['telefono', 'nombre', 'observacion']);

    const indexRes = await app.inject({ method: 'GET', url: '/' });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).toContain('Masivos-wsp');
    expect(indexRes.body).not.toContain('sample.csv');

    const dotEnvRes = await app.inject({ method: 'GET', url: '/.env' });
    expect(dotEnvRes.statusCode).toBeGreaterThanOrEqual(400);

    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/waha/session',
      headers: { 'x-admin-token': adminToken },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json().session.raw).toBeUndefined();

    await app.close();
    db.close();
  });

  it('exige NOMBRE cuando se usa la plantilla por defecto y subdivide archivos grandes en tandas', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      WORKER_CHUNK_SIZE: '25',
      WORKER_MAX_BATCH_SIZE: '100',
      WORKER_ENABLED: 'false',
    });
    const db = createDatabase(':memory:');
    const { app } = buildApp({
      config,
      db,
      wahaClient: createMockWaha(),
      logger: false,
    });

    const missingNameRes = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: {
        name: 'Sin nombre',
        rows: [{ telefono: '01144045549', observacion: 'falta nombre' }],
      },
    });
    expect(missingNameRes.statusCode).toBe(400);
    expect(missingNameRes.json().preview.items[0].error).toContain('NOMBRE');

    const rows60 = Array.from({ length: 60 }, (_, idx) => ({
      telefono: `0114404${String(1000 + idx)}`,
      nombre: `Cliente ${idx + 1}`,
      observacion: `Obs ${idx + 1}`,
    }));
    const largeRes = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { name: 'Lote 60 en tandas', rows: rows60 },
    });
    expect(largeRes.statusCode).toBe(201);
    expect(largeRes.json().chunkCount).toBe(3);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/batches/${largeRes.json().batch.id}`,
    });
    const msgs = detail.json().messages;
    expect(msgs[0].chunk_index).toBe(1);
    expect(msgs[24].chunk_index).toBe(1);
    expect(msgs[25].chunk_index).toBe(2);
    expect(msgs[50].chunk_index).toBe(3);

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
          { to: '01144045549', text: 'Uno' },
          { to: '01139563183', text: 'Dos' },
          { to: '01151443664', text: 'Tres' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('excede el máximo permitido');

    await app.close();
    db.close();
  });

  it('falla al iniciar si AUTH_REQUIRED=true y falta ADMIN_API_TOKEN o usa el valor por defecto', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        AUTH_REQUIRED: 'true',
        ADMIN_API_TOKEN: '',
      })
    ).toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        AUTH_REQUIRED: 'true',
        ADMIN_API_TOKEN: 'cambia_esta_clave_de_acceso',
      })
    ).toThrow();
  });

  it('agrega cookie Secure detrás de proxy HTTPS y bloquea tras 5 intentos fallidos por IP', async () => {
    const adminToken = 'clave-super-segura-proxy-test-123';
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      AUTH_REQUIRED: 'true',
      ADMIN_API_TOKEN: adminToken,
      WORKER_ENABLED: 'false',
    });
    const db = createDatabase(':memory:');
    const { app } = buildApp({
      config,
      db,
      wahaClient: createMockWaha(),
      logger: false,
    });

    const httpsLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-proto': 'https',
      },
      payload: { password: adminToken },
    });
    expect(httpsLogin.statusCode).toBe(200);
    const cookieAttr = String(httpsLogin.headers['set-cookie']);
    expect(cookieAttr).toContain('HttpOnly');
    expect(cookieAttr).toContain('SameSite=Lax');
    expect(cookieAttr).toContain('; Secure');

    const healthWithCookie = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: cookieAttr.split(';')[0] },
    });
    expect(healthWithCookie.statusCode).toBe(200);
    expect(healthWithCookie.json().config.defaultMessageTemplate).toContain('Asistodo');

    for (let i = 0; i < 5; i += 1) {
      const failRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.20' },
        payload: { password: 'clave-incorrecta' },
      });
      expect(failRes.statusCode).toBe(401);
    }

    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.20' },
      payload: { password: adminToken },
    });
    expect(blockedRes.statusCode).toBe(429);

    const otherIpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.21' },
      payload: { password: adminToken },
    });
    expect(otherIpRes.statusCode).toBe(200);

    await app.close();
    db.close();
  });

  it('envía cabeceras de seguridad CSP/anti-indexación y bloquea webhooks desde proxy externo', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      WORKER_ENABLED: 'false',
    });
    const db = createDatabase(':memory:');
    const { app } = buildApp({
      config,
      db,
      wahaClient: createMockWaha(),
      logger: false,
    });

    const rootRes = await app.inject({ method: 'GET', url: '/' });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.headers['x-content-type-options']).toBe('nosniff');
    expect(rootRes.headers['x-frame-options']).toBe('DENY');
    expect(rootRes.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(String(rootRes.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(rootRes.headers['content-security-policy'])).toContain("style-src 'self'");

    const proxiedWebhook = await app.inject({
      method: 'POST',
      url: '/api/webhooks/waha',
      headers: { 'x-forwarded-for': '203.0.113.50' },
      payload: { event: 'message' },
    });
    expect(proxiedWebhook.statusCode).toBe(403);

    await app.close();
    db.close();
  });

  it('limpia historial de lotes finalizados (conservando activos) y limpia historial de mensajes', async () => {
    const adminToken = 'token-limpieza-manual-123';
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ADMIN_API_TOKEN: adminToken,
      WORKER_ENABLED: 'false',
    });
    const db = createDatabase(':memory:');
    const { app, batchRepo, messageRepo } = buildApp({
      config,
      db,
      wahaClient: createMockWaha(),
      logger: false,
    });

    // Protegido por autenticación
    const unauthClearBatches = await app.inject({ method: 'DELETE', url: '/api/batches/history' });
    expect(unauthClearBatches.statusCode).toBe(401);
    const unauthClearMsgs = await app.inject({ method: 'DELETE', url: '/api/messages/history' });
    expect(unauthClearMsgs.statusCode).toBe(401);

    // Creamos 1 lote cancelado (finalizado), 1 lote completado hoy y 1 lote pendiente (activo)
    const cancelledBatch = batchRepo.createBatch({
      name: 'Cancelado',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01144045541',
          phoneNormalized: '5491144045541',
          chatId: '5491144045541@c.us',
          variables: {},
          renderedText: 'Hola 1',
        },
      ],
    });
    batchRepo.cancelBatch(cancelledBatch.id);

    const completedBatch = batchRepo.createBatch({
      name: 'Completado hoy',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01144045542',
          phoneNormalized: '5491144045542',
          chatId: '5491144045542@c.us',
          variables: {},
          renderedText: 'Hola 2',
        },
      ],
    });
    const [completedMsg] = batchRepo.getBatchMessages(completedBatch.id);
    batchRepo.claimMessageForProcessing(completedMsg.id);
    batchRepo.markMessageSent(completedMsg.id, 'wamid-1');
    batchRepo.refreshBatchStatus(completedBatch.id);

    const pendingBatch = batchRepo.createBatch({
      name: 'Pendiente activo',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01144045543',
          phoneNormalized: '5491144045543',
          chatId: '5491144045543@c.us',
          variables: {},
          renderedText: 'Hola 3',
        },
      ],
    });

    const clearBatchesRes = await app.inject({
      method: 'DELETE',
      url: '/api/batches/history',
      headers: { 'x-admin-token': adminToken },
    });
    expect(clearBatchesRes.statusCode).toBe(200);
    expect(clearBatchesRes.json()).toMatchObject({
      ok: true,
      deletedBatches: 2,
      deletedMessages: 2,
      remainingBatches: 1,
      preservedSentToday: 1,
    });

    const remainingRes = await app.inject({
      method: 'GET',
      url: '/api/batches',
      headers: { 'x-admin-token': adminToken },
    });
    expect(remainingRes.json().batches).toHaveLength(1);
    expect(remainingRes.json().batches[0].id).toBe(pendingBatch.id);
    expect(remainingRes.json().worker.sentToday).toBe(1);

    // Mensajes en bandeja
    messageRepo.saveMessage({
      wahaMessageId: 'msg-hist-1',
      sessionName: 'default',
      eventType: 'message',
      direction: 'IN',
      fromMe: false,
      chatId: '5491144045541@c.us',
      rawChatId: '5491144045541@c.us',
      senderPhone: '5491144045541',
      senderName: 'Ana',
      body: 'Hola',
      messageType: 'chat',
      hasMedia: false,
      ack: null,
      timestampUnix: 1763481000,
      payloadJson: '{}',
    });

    const clearMsgsRes = await app.inject({
      method: 'DELETE',
      url: '/api/messages/history',
      headers: { 'x-admin-token': adminToken },
    });
    expect(clearMsgsRes.statusCode).toBe(200);
    expect(clearMsgsRes.json()).toMatchObject({
      ok: true,
      deletedMessages: 1,
    });

    const convAfterRes = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'x-admin-token': adminToken },
    });
    expect(convAfterRes.json().conversations).toEqual([]);

    await app.close();
    db.close();
  });
});
