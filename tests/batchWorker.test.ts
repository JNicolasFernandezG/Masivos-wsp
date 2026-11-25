import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { BatchRepository } from '../src/repositories/batchRepository.js';
import { EventBus } from '../src/services/eventBus.js';
import { getLocalClock, getStartOfLocalDayUtc } from '../src/services/businessHours.js';
import type { WahaClient } from '../src/services/wahaClient.js';
import { BatchWorker } from '../src/worker/batchWorker.js';

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    TZ: 'America/Argentina/Buenos_Aires',
    WORKER_MIN_DELAY_MS: '20000',
    WORKER_MAX_DELAY_MS: '60000',
    WORKER_POLL_INTERVAL_MS: '500',
    WORKER_CHUNK_SIZE: '25',
    WORKER_CHUNK_PAUSE_MIN_MS: '2700000',
    WORKER_CHUNK_PAUSE_MAX_MS: '3600000',
    WORKER_DAILY_LIMIT: '125',
    BUSINESS_HOURS_ENABLED: 'true',
    BUSINESS_HOURS_START: '09:00',
    BUSINESS_HOURS_END: '19:00',
    BUSINESS_ALLOWED_DAYS: '1,2,3,4,5,6',
    ...overrides,
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
  it('procesa mensajes de a uno respetando el jitter dentro de horario comercial', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig();

    const sendText = vi
      .fn()
      .mockResolvedValueOnce({ id: 'wamid-1', raw: {} })
      .mockRejectedValueOnce(new Error('Número inválido en WhatsApp'));

    const wahaClient = makeMockWaha({ sendText });

    // Jueves 2026-11-19 10:00 ART (13:00 UTC)
    let fakeNow = Date.parse('2026-11-19T13:00:00.000Z');
    const sleepCalls: number[] = [];

    const worker = new BatchWorker({
      batchRepo,
      wahaClient,
      eventBus,
      config,
      nowFn: () => fakeNow,
      maxSleepSliceMs: Number.POSITIVE_INFINITY,
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
          chunkIndex: 1,
          recipientRaw: '01111111111',
          phoneNormalized: '5491111111111',
          chatId: '5491111111111@c.us',
          variables: { nombre: 'Ana' },
          renderedText: 'Hola Ana',
        },
        {
          chunkIndex: 1,
          recipientRaw: '01122222222',
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
    expect(sleepCalls).toEqual([]);

    const second = await worker.processSingleTick();
    expect(second).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([35000]);

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

  it('prohíbe enviar fuera del horario comercial (ej. 19:05 ART)', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig();
    const sendText = vi.fn();
    const wahaClient = makeMockWaha({ sendText });

    // Jueves 2026-11-19 19:05 ART = 22:05 UTC
    const fakeNow = Date.parse('2026-11-19T22:05:00.000Z');
    const worker = new BatchWorker({
      batchRepo,
      wahaClient,
      eventBus,
      config,
      nowFn: () => fakeNow,
      sleepFn: async () => undefined,
    });

    batchRepo.createBatch({
      name: 'Nocturno',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01111111111',
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
    expect(worker.getStatus().pauseReason).toBe('OUTSIDE_HOURS');
    expect(worker.getStatus().nextSendAt).toBe('2026-11-20T12:00:00.000Z');
    db.close();
  });

  it('pausa entre tandas (persiste en SQLite) y respeta el máximo diario', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig({
      WORKER_CHUNK_SIZE: '2',
      WORKER_CHUNK_PAUSE_MIN_MS: '3000000',
      WORKER_CHUNK_PAUSE_MAX_MS: '3600000',
      WORKER_DAILY_LIMIT: '3',
    });

    const sendText = vi.fn().mockResolvedValue({ id: 'wamid-ok', raw: {} });
    const wahaClient = makeMockWaha({ sendText });

    // 10:00 ART
    let fakeNow = Date.parse('2026-11-19T13:00:00.000Z');

    const createWorker = () =>
      new BatchWorker({
        batchRepo,
        wahaClient,
        eventBus,
        config,
        nowFn: () => fakeNow,
        maxSleepSliceMs: Number.POSITIVE_INFINITY,
        randomIntFn: (min, max) => max, // 60s jitter, 60m chunk pause
        sleepFn: async (ms) => {
          fakeNow += ms;
        },
      });

    let worker = createWorker();

    batchRepo.createBatch({
      name: 'Lote grande',
      source: 'api',
      template: null,
      items: [1, 2, 3, 4].map((n) => ({
        chunkIndex: n <= 2 ? 1 : 2,
        recipientRaw: `0114404554${n}`,
        phoneNormalized: `549114404554${n}`,
        chatId: `549114404554${n}@c.us`,
        variables: {},
        renderedText: `Mensaje ${n}`,
      })),
    });

    // Tanda 1: mensajes 1 y 2
    expect(await worker.processSingleTick()).toBe(true);
    expect(await worker.processSingleTick()).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);

    // Simulamos reinicio creando otra instancia de BatchWorker con el mismo DB
    worker = createWorker();
    const beforePauseEnd = fakeNow;
    expect(await worker.processSingleTick()).toBe(false);
    expect(worker.getStatus().pauseReason).toBe('CHUNK_PAUSE');
    expect(fakeNow - beforePauseEnd).toBe(3600000); // Esperó los 60 min

    // Ya cumplida la pausa entre tandas, envía el mensaje 3 (tope diario = 3)
    expect(await worker.processSingleTick()).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(3);

    // El mensaje 4 queda bloqueado por tope diario (3/3)
    expect(await worker.processSingleTick()).toBe(false);
    expect(worker.getStatus().pauseReason).toBe('DAILY_LIMIT_REACHED');
    expect(sendText).toHaveBeenCalledTimes(3);
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
      nowFn: () => Date.parse('2026-11-19T14:00:00.000Z'),
      sleepFn: async () => undefined,
    });

    const batch = batchRepo.createBatch({
      name: 'Lote en espera',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01111111111',
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
          chunkIndex: 1,
          recipientRaw: '01111111111',
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

  it('conserva la cuota diaria anti-baneo al limpiar lotes finalizados del día', async () => {
    const db = createDatabase(':memory:');
    const batchRepo = new BatchRepository(db);
    const eventBus = new EventBus();
    const config = makeConfig({
      BUSINESS_HOURS_ENABLED: 'false',
      WORKER_MIN_DELAY_MS: '0',
      WORKER_MAX_DELAY_MS: '0',
      WORKER_CHUNK_SIZE: '10',
      WORKER_CHUNK_PAUSE_MIN_MS: '0',
      WORKER_CHUNK_PAUSE_MAX_MS: '0',
      WORKER_DAILY_LIMIT: '2',
    });

    const sendText = vi.fn().mockResolvedValue({ id: 'wamid-quota', raw: {} });
    const wahaClient = makeMockWaha({ sendText });
    const worker = new BatchWorker({
      batchRepo,
      wahaClient,
      eventBus,
      config,
      sleepFn: async () => undefined,
    });

    batchRepo.createBatch({
      name: 'Lote completado hoy',
      source: 'api',
      template: null,
      items: [1, 2].map((n) => ({
        chunkIndex: 1,
        recipientRaw: `0114404554${n}`,
        phoneNormalized: `549114404554${n}`,
        chatId: `549114404554${n}@c.us`,
        variables: {},
        renderedText: `Mensaje ${n}`,
      })),
    });

    expect(await worker.processSingleTick()).toBe(true);
    expect(await worker.processSingleTick()).toBe(true);
    expect(worker.getStatus().sentToday).toBe(2);

    const now = new Date();
    const clock = getLocalClock(now, config.timezone);
    const startOfToday = getStartOfLocalDayUtc(now, config.timezone);
    const cleared = batchRepo.clearFinishedBatches(clock.dateKey, startOfToday.toISOString());

    expect(cleared.deletedBatches).toBe(1);
    expect(cleared.deletedMessages).toBe(2);
    expect(cleared.remainingBatches).toBe(0);
    expect(cleared.preservedSentToday).toBe(2);

    // Aunque ya no haya lotes en SQLite, la cuota diaria sigue en 2/2
    expect(worker.getStatus().sentToday).toBe(2);

    // Si se carga un lote nuevo hoy, el worker bloquea por tope diario
    batchRepo.createBatch({
      name: 'Lote extra mismo día',
      source: 'api',
      template: null,
      items: [
        {
          chunkIndex: 1,
          recipientRaw: '01144045549',
          phoneNormalized: '5491144045549',
          chatId: '5491144045549@c.us',
          variables: {},
          renderedText: 'No debería salir hoy',
        },
      ],
    });

    expect(await worker.processSingleTick()).toBe(false);
    expect(worker.getStatus().pauseReason).toBe('DAILY_LIMIT_REACHED');
    expect(sendText).toHaveBeenCalledTimes(2);
    db.close();
  });
});
