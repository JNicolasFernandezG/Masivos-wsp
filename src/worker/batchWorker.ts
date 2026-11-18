import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { BatchRepository, OutboundMessageRecord } from '../repositories/batchRepository.js';
import type { EventBus } from '../services/eventBus.js';
import type { WahaClient } from '../services/wahaClient.js';

export interface WorkerRuntimeStatus {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  sessionStatus: string;
  lastSentAt: string | null;
  nextSendAt: string | null;
  currentMessageId: number | null;
  lastError: string | null;
  minDelayMs: number;
  maxDelayMs: number;
}

export interface BatchWorkerDeps {
  batchRepo: BatchRepository;
  wahaClient: WahaClient;
  eventBus: EventBus;
  config: AppConfig;
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
  randomIntFn?: (min: number, maxInclusive: number) => number;
  nowFn?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultRandomInt(min: number, maxInclusive: number): number {
  if (maxInclusive <= min) return min;
  return crypto.randomInt(min, maxInclusive + 1);
}

export class BatchWorker {
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly randomInt: (min: number, maxInclusive: number) => number;
  private readonly now: () => number;

  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private running = false;
  private busy = false;
  private sessionStatus = 'UNKNOWN';
  private lastSentAtMs: number | null = null;
  private nextAllowedSendAtMs: number | null = null;
  private currentMessageId: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: BatchWorkerDeps) {
    this.sleep = deps.sleepFn ?? defaultSleep;
    this.randomInt = deps.randomIntFn ?? defaultRandomInt;
    this.now = deps.nowFn ?? Date.now;
  }

  getStatus(): WorkerRuntimeStatus {
    return {
      enabled: this.deps.config.workerEnabled,
      running: this.running,
      busy: this.busy,
      sessionStatus: this.sessionStatus,
      lastSentAt: this.lastSentAtMs ? new Date(this.lastSentAtMs).toISOString() : null,
      nextSendAt:
        this.nextAllowedSendAtMs && this.nextAllowedSendAtMs > this.now()
          ? new Date(this.nextAllowedSendAtMs).toISOString()
          : null,
      currentMessageId: this.currentMessageId,
      lastError: this.lastError,
      minDelayMs: this.deps.config.workerMinDelayMs,
      maxDelayMs: this.deps.config.workerMaxDelayMs,
    };
  }

  private emitStatus(): void {
    this.deps.eventBus.emit('worker.status', this.getStatus());
  }

  start(): void {
    if (this.running) return;
    this.deps.batchRepo.recoverStuckProcessing();
    this.abortController = new AbortController();
    this.running = true;
    this.emitStatus();
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    await this.loopPromise;
    this.loopPromise = null;
    this.abortController = null;
    this.emitStatus();
  }

  /**
   * Executes one iteration of the queue worker. Exposed for deterministic testing.
   * Returns true if a message send was attempted, false if idle or deferred.
   */
  async processSingleTick(signal?: AbortSignal): Promise<boolean> {
    const abortSignal = signal ?? new AbortController().signal;
    const nextPending = this.deps.batchRepo.findNextPendingMessage();
    if (!nextPending) {
      this.nextAllowedSendAtMs = null;
      return false;
    }

    if (this.nextAllowedSendAtMs !== null) {
      const waitMs = this.nextAllowedSendAtMs - this.now();
      if (waitMs > 0) {
        this.emitStatus();
        await this.sleep(waitMs, abortSignal);
        if (abortSignal.aborted) return false;
      }
    }

    // Re-check after waiting in case the batch was paused or cancelled during jitter.
    const refreshedNext = this.deps.batchRepo.findNextPendingMessage();
    if (!refreshedNext) {
      this.nextAllowedSendAtMs = null;
      return false;
    }

    let sessionReady = false;
    try {
      const session = await this.deps.wahaClient.getSession(this.deps.config.wahaSession);
      this.sessionStatus = session?.status ?? 'STOPPED';
      sessionReady = this.sessionStatus === 'WORKING';
      if (!sessionReady) {
        this.lastError = `Sesión "${this.deps.config.wahaSession}" en estado ${this.sessionStatus} (se requiere WORKING).`;
      }
    } catch (err) {
      this.sessionStatus = 'UNREACHABLE';
      this.lastError =
        err instanceof Error ? err.message : 'No se pudo consultar la sesión de WAHA.';
    }

    if (!sessionReady) {
      this.emitStatus();
      await this.sleep(Math.max(this.deps.config.workerPollIntervalMs, 5000), abortSignal);
      return false;
    }

    const claimed = this.deps.batchRepo.claimMessageForProcessing(refreshedNext.id);
    if (!claimed) {
      return false;
    }

    await this.dispatchClaimedMessage(claimed);
    return true;
  }

  private async dispatchClaimedMessage(claimed: OutboundMessageRecord): Promise<void> {
    this.busy = true;
    this.currentMessageId = claimed.id;
    this.lastError = null;
    this.deps.eventBus.emit('outbound.updated', claimed);
    const batchBefore = this.deps.batchRepo.getBatchById(claimed.batch_id);
    if (batchBefore) {
      this.deps.eventBus.emit('batch.updated', batchBefore);
    }
    this.emitStatus();

    try {
      const result = await this.deps.wahaClient.sendText(
        this.deps.config.wahaSession,
        claimed.chat_id,
        claimed.rendered_text
      );
      const updated = this.deps.batchRepo.markMessageSent(claimed.id, result.id);
      this.lastSentAtMs = this.now();
      this.scheduleNextJitter();
      this.deps.eventBus.emit('outbound.updated', updated);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Error desconocido enviando mensaje.';
      this.lastError = errMsg;
      const updated = this.deps.batchRepo.markMessageError(claimed.id, errMsg);
      this.lastSentAtMs = this.now();
      this.scheduleNextJitter();
      this.deps.eventBus.emit('outbound.updated', updated);
    } finally {
      this.busy = false;
      this.currentMessageId = null;
      const batchAfter = this.deps.batchRepo.refreshBatchStatus(claimed.batch_id);
      if (batchAfter) {
        this.deps.eventBus.emit('batch.updated', batchAfter);
      }
      this.emitStatus();
    }
  }

  private scheduleNextJitter(): void {
    const delayMs = this.randomInt(
      this.deps.config.workerMinDelayMs,
      this.deps.config.workerMaxDelayMs
    );
    this.nextAllowedSendAtMs = this.now() + delayMs;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.running) {
      try {
        const processed = await this.processSingleTick(signal);
        if (!processed && !signal.aborted && this.running) {
          await this.sleep(this.deps.config.workerPollIntervalMs, signal);
        }
      } catch (err) {
        this.lastError =
          err instanceof Error ? err.message : 'Error inesperado en el worker.';
        this.emitStatus();
        if (!signal.aborted && this.running) {
          await this.sleep(this.deps.config.workerPollIntervalMs, signal);
        }
      }
    }
  }
}
