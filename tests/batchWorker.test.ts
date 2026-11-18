import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { BatchRepository } from '../src/repositories/batchRepository.js';
import { EventBus } from '../src/services/eventBus.js';
import type { WahaClient } from '../src/services/wahaClient.js';
import { BatchWorker } from '../src/worker/batchWorker.js';

function makeConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    WORKER_MIN_DELAY_MS: '20000',
    WORKER_MAX_DELAY_MS: '60000',
    WORKER_POLL_INTERVAL_MS: '500',
  });
}

function makeMockWaha(overrides: Partial<WahaClient> = {}): WahaClient {
  return {
    getSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING' }),
    startSession: vi.fn().mockResolvedValue({ name: 'default', status: 'WORKING' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    restartSession: vi.fn().mockResolvedValue(undefined),
    logoutSession: vi.fn().mockResolvedValue(undefined),
    getQrCode: vi.fn().mockResolvedValue({ mimetype: 'image/png', data: '' }),
    requestPairingCode: vi.fn().mockResolvedValue({ code: '1234-5678' }),
    sendText: vi.fn().mockResolvedValue({ id: 'waha-id-1', raw: {} }),
    resolveLidToPhone: vi.fn().mockResolvedValue(null),
    ping: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('BatchWorker', () => {
  it('procesa mensajes de a uno respetando el jitter entre envíos y actualiza el estado del lote', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig();

    const sendText = vi
      .fn()
      .mockResolvedValueOnce({ id: 'wamid-1', raw: {} })
      .mockRejectedValueOnce(new Error('Número inválido en WhatsApp'));

    const wahaClient = makeMockWaha({ sendText });

    let fakeNow = 1_700_000_000_000;
    const sleepCalls: number[] = [];

    const worker = new BatchWorker({
      batchRepo,
      wahaClient,
      eventBus,
      config,
      nowFn: () => fakeNow,
      randomIntFn: (min, max) => {
        expect(min).toBe(20000);
        expect(max).toBe(60000);
        return 35000;
      },
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        fakeNow += ms;
      },
    });

    const batch = batchRepo.createBatch({
      name: 'Lote test',
      source: 'api',
      template: 'Hola {{nombre}}',
      items: [
        {
          recipientRaw: '5491111111111',
          phoneNormalized: '5491111111111',
          chatId: '5491111111111@c.us',
          variables: { nombre: 'Ana' },
          renderedText: 'Hola Ana',
        },
        {
          recipientRaw: '5491122222222',
          phoneNormalized: '5491122222222',
          chatId: '5491122222222@c.us',
          variables: { nombre: 'Carlos' },
          renderedText: 'Hola Carlos',
        },
      ],
    });

    const first = await worker.processSingleTick();
    expect(first).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([]); // Primer mensaje sale sin espera previa

    const second = await worker.processSingleTick();
    expect(second).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([35000]); // Jitter aplicado antes del segundo envío

    const updatedBatch = batchRepo.getBatchById(batch.id);
    const messages = batchRepo.getBatchMessages(batch.id);
    expect(updatedBatch?.status).toBe('COMPLETADO_CON_ERRORES');
    expect(updatedBatch?.sent_count).toBe(1);
    expect(updatedBatch?.error_count).toBe(1);
    expect(messages[0].status).toBe('ENVIADO');
    expect(messages[0].waha_message_id).toBe('wamid-1');
    expect(messages[1].status).toBe('ERROR');
    expect(messages[1].error_message).toContain('Número inválido');

    const idle = await worker.processSingleTick();
    expect(idle).toBe(false);
    db.close();
  });

  it('difiere el envío sin marcar ERROR si la sesión WAHA no está en WORKING', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig();
    const sendText = vi.fn();
    const wahaClient = makeMockWaha({
      getSession: vi.fn().mockResolvedValue({ name: 'default', status: 'SCAN_QR_CODE' }),
      sendText,
    });

    const worker = new BatchWorker({
      batchRepo,
      wahaClient,
      eventBus,
      config,
      sleepFn: async () => undefined,
    });

    const batch = batchRepo.createBatch({
      name: 'Lote en espera',
      source: 'api',
      template: null,
      items: [
        {
          recipientRaw: '5491111111111',
          phoneNormalized: '5491111111111',
          chatId: '5491111111111@c.us',
          variables: {},
          renderedText: 'Prueba',
        },
      ],
    });

    const processed = await worker.processSingleTick();
    expect(processed).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(batchRepo.getBatchById(batch.id)?.pending_count).toBe(1);
    db.close();
  });

  it('recupera mensajes atascados en PROCESANDO tras reinicio y respeta pausa de lote', () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);

    const batch = batchRepo.createBatch({
      name: 'Recuperación',
      source: 'api',
      template: null,
      items: [
        {
          recipientRaw: '5491111111111',
          phoneNormalized: '5491111111111',
          chatId: '5491111111111@c.us',
          variables: {},
          renderedText: 'Uno',
        },
      ],
    });

    const [msg] = batchRepo.getBatchMessages(batch.id);
    batchRepo.claimMessageForProcessing(msg.id);
    expect(batchRepo.getBatchMessages(batch.id)[0].status).toBe('PROCESANDO');

    const recovered = batchRepo.recoverStuckProcessing();
    expect(recovered).toBe(1);
    expect(batchRepo.getBatchMessages(batch.id)[0].status).toBe('PENDIENTE');

    batchRepo.pauseBatch(batch.id);
    expect(batchRepo.findNextPendingMessage()).toBeNull();

    batchRepo.resumeBatch(batch.id);
    expect(batchRepo.findNextPendingMessage()?.id).toBe(msg.id);
    db.close();
  });
});
