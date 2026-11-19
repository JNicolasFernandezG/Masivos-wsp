import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { BatchRepository, OutboundMessageRecord } from '../repositories/batchRepository.js';
import {
  checkBusinessHours,
  getNextBusinessDayStart,
  getStartOfLocalDayUtc,
} from '../services/businessHours.js';
import type { EventBus } from '../services/eventBus.js';
import type { WahaClient } from '../services/wahaClient.js';

export type WorkerPauseReason =
  | 'NONE'
  | 'MESSAGE_JITTER'
  | 'CHUNK_PAUSE'
  | 'DAILY_LIMIT_REACHED'
  | 'OUTSIDE_HOURS'
  | 'NON_BUSINESS_DAY'
  | 'SESSION_NOT_READY';

export interface WorkerRuntimeStatus {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  sessionStatus: string;
  pauseReason: WorkerPauseReason;
  sentToday: number;
  dailyLimit: number;
  chunkSize: number;
  sentInCurrentChunk: number;
  businessHoursEnabled: boolean;
  businessHoursWindow: string;
  timezone: string;
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
  maxSleepSliceMs?: number;
}

const STATE_CHUNK_PAUSE_UNTIL = 'chunk_pause_until';
const STATE_CONSECUTIVE_SENT = 'consecutive_sent_since_chunk_pause';

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
  private readonly maxSleepSliceMs: number;

  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private running = false;
  private busy = false;
  private sessionStatus = 'UNKNOWN';
  private pauseReason: WorkerPauseReason = 'NONE';
  private lastSentAtMs: number | null = null;
  private nextAllowedSendAtMs: number | null = null;
  private nextJitterSendAtMs: number | null = null;
  private currentMessageId: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: BatchWorkerDeps) {
    this.sleep = deps.sleepFn ?? defaultSleep;
    this.randomInt = deps.randomIntFn ?? defaultRandomInt;
    this.now = deps.nowFn ?? Date.now;
    this.maxSleepSliceMs = deps.maxSleepSliceMs ?? 15000;
  }

  private getSentTodayCount(nowMs: number): number {
    const startOfToday = getStartOfLocalDayUtc(new Date(nowMs), this.deps.config.timezone);
    return this.deps.batchRepo.countSentSince(startOfToday.toISOString());
  }

  private getConsecutiveChunkCount(): number {
    const raw = this.deps.batchRepo.getWorkerState(STATE_CONSECUTIVE_SENT);
    const num = raw ? Number(raw) : 0;
    return Number.isFinite(num) && num >= 0 ? num : 0;
  }

  private getChunkPauseUntilMs(): number | null {
    const raw = this.deps.batchRepo.getWorkerState(STATE_CHUNK_PAUSE_UNTIL);
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  getStatus(): WorkerRuntimeStatus {
    const nowMs = this.now();
    const sentToday = this.getSentTodayCount(nowMs);
    const lastSent = this.lastSentAtMs
      ? new Date(this.lastSentAtMs).toISOString()
      : this.deps.batchRepo.getLastSentMessage()?.sent_at ?? null;

    return {
      enabled: this.deps.config.workerEnabled,
      running: this.running,
      busy: this.busy,
      sessionStatus: this.sessionStatus,
      pauseReason: this.pauseReason,
      sentToday,
      dailyLimit: this.deps.config.workerDailyLimit,
      chunkSize: this.deps.config.workerChunkSize,
      sentInCurrentChunk: this.getConsecutiveChunkCount(),
      businessHoursEnabled: this.deps.config.businessHoursEnabled,
      businessHoursWindow: `${this.deps.config.businessHoursStart}–${this.deps.config.businessHoursEnd}`,
      timezone: this.deps.config.timezone,
      lastSentAt: lastSent,
      nextSendAt:
        this.nextAllowedSendAtMs && this.nextAllowedSendAtMs > nowMs
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

  private async sleepUntilOrSlice(
    targetMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const remaining = targetMs - this.now();
    if (remaining <= 0 || signal.aborted) return;
    const slice = Math.min(remaining, this.maxSleepSliceMs);
    await this.sleep(slice, signal);
  }

  /**
   * Executes one iteration of the queue worker. Exposed for deterministic testing.
   * Returns true if a message send was attempted, false if idle or deferred.
   */
  async processSingleTick(signal?: AbortSignal): Promise<boolean> {
    const abortSignal = signal ?? new AbortController().signal;
    const nextPending = this.deps.batchRepo.findNextPendingMessage();
    if (!nextPending) {
      this.pauseReason = 'NONE';
      this.nextAllowedSendAtMs = null;
      return false;
    }

    const nowMs = this.now();

    // 1. Strict business hours check
    const bh = checkBusinessHours(new Date(nowMs), this.deps.config);
    if (!bh.allowed) {
      this.pauseReason = bh.reason ?? 'OUTSIDE_HOURS';
      this.nextAllowedSendAtMs = bh.nextWindowStart ? bh.nextWindowStart.getTime() : null;
      this.emitStatus();
      await this.sleepUntilOrSlice(
        this.nextAllowedSendAtMs ?? nowMs + this.deps.config.workerPollIntervalMs,
        abortSignal
      );
      return false;
    }

    // 2. Strict daily limit check
    const sentToday = this.getSentTodayCount(nowMs);
    if (sentToday >= this.deps.config.workerDailyLimit) {
      const nextDayStart = getNextBusinessDayStart(new Date(nowMs), this.deps.config);
      this.pauseReason = 'DAILY_LIMIT_REACHED';
      this.nextAllowedSendAtMs = nextDayStart
        ? nextDayStart.getTime()
        : getStartOfLocalDayUtc(new Date(nowMs + 86400000), this.deps.config.timezone).getTime();
      this.emitStatus();
      await this.sleepUntilOrSlice(this.nextAllowedSendAtMs, abortSignal);
      return false;
    }

    // 3. Persistent inter-chunk pause check (45–60 min max between tandas of 25)
    const chunkPauseUntilMs = this.getChunkPauseUntilMs();
    if (chunkPauseUntilMs !== null) {
      if (chunkPauseUntilMs > nowMs) {
        this.pauseReason = 'CHUNK_PAUSE';
        this.nextAllowedSendAtMs = chunkPauseUntilMs;
        this.emitStatus();
        await this.sleepUntilOrSlice(chunkPauseUntilMs, abortSignal);
        return false;
      }
      // Pause finished: clear persisted pause & reset counter for new chunk
      this.deps.batchRepo.setWorkerState(STATE_CHUNK_PAUSE_UNTIL, null);
      this.deps.batchRepo.setWorkerState(STATE_CONSECUTIVE_SENT, '0');
    }

    // Also auto-reset chunk counter if naturally idle longer than min chunk pause
    const lastSentRecord = this.deps.batchRepo.getLastSentMessage();
    const lastSentTimeMs =
      this.lastSentAtMs ?? (lastSentRecord ? Date.parse(lastSentRecord.sent_at) : null);
    if (
      lastSentTimeMs !== null &&
      this.deps.config.workerChunkPauseMinMs > 0 &&
      nowMs - lastSentTimeMs >= this.deps.config.workerChunkPauseMinMs &&
      this.getConsecutiveChunkCount() > 0
    ) {
      this.deps.batchRepo.setWorkerState(STATE_CONSECUTIVE_SENT, '0');
    }

    // 4. Per-message anti-ban jitter (20–60 s)
    if (this.nextJitterSendAtMs !== null && this.nextJitterSendAtMs > nowMs) {
      this.pauseReason = 'MESSAGE_JITTER';
      this.nextAllowedSendAtMs = this.nextJitterSendAtMs;
      this.emitStatus();
      await this.sleep(this.nextJitterSendAtMs - nowMs, abortSignal);
      if (abortSignal.aborted) return false;
    }

    // Re-check business hours and pending message after sleeping
    const postSleepNow = this.now();
    const postSleepBh = checkBusinessHours(new Date(postSleepNow), this.deps.config);
    if (!postSleepBh.allowed) {
      this.pauseReason = postSleepBh.reason ?? 'OUTSIDE_HOURS';
      this.nextAllowedSendAtMs = postSleepBh.nextWindowStart
        ? postSleepBh.nextWindowStart.getTime()
        : null;
      this.emitStatus();
      return false;
    }

    const refreshedNext = this.deps.batchRepo.findNextPendingMessage();
    if (!refreshedNext) {
      this.pauseReason = 'NONE';
      this.nextAllowedSendAtMs = null;
      return false;
    }

    // 5. Verify WAHA session is WORKING
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
      this.pauseReason = 'SESSION_NOT_READY';
      this.emitStatus();
      await this.sleep(Math.max(this.deps.config.workerPollIntervalMs, 5000), abortSignal);
      return false;
    }

    const claimed = this.deps.batchRepo.claimMessageForProcessing(refreshedNext.id);
    if (!claimed) {
      return false;
    }

    this.pauseReason = 'NONE';
    this.nextAllowedSendAtMs = null;
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
      this.scheduleAfterSend(true);
      this.deps.eventBus.emit('outbound.updated', updated);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Error desconocido enviando mensaje.';
      this.lastError = errMsg;
      const updated = this.deps.batchRepo.markMessageError(claimed.id, errMsg);
      this.lastSentAtMs = this.now();
      this.scheduleAfterSend(false);
      this.deps.eventBus.emit('outbound.updated', updated);
    } finally {
      this.busy = false;
      this.currentMessageId = null;
      if (!this.deps.batchRepo.findNextPendingMessage()) {
        this.pauseReason = 'NONE';
        this.nextAllowedSendAtMs = null;
      }
      const batchAfter = this.deps.batchRepo.refreshBatchStatus(claimed.batch_id);
      if (batchAfter) {
        this.deps.eventBus.emit('batch.updated', batchAfter);
      }
      this.emitStatus();
    }
  }

  private scheduleAfterSend(succeeded: boolean): void {
    const nowMs = this.now();
    const jitterMs = this.randomInt(
      this.deps.config.workerMinDelayMs,
      this.deps.config.workerMaxDelayMs
    );
    this.nextJitterSendAtMs = nowMs + jitterMs;

    if (succeeded) {
      const nextCount = this.getConsecutiveChunkCount() + 1;
      if (
        nextCount >= this.deps.config.workerChunkSize &&
        this.deps.config.workerChunkPauseMaxMs > 0
      ) {
        const pauseMs = this.randomInt(
          this.deps.config.workerChunkPauseMinMs,
          this.deps.config.workerChunkPauseMaxMs
        );
        const resumeAtIso = new Date(nowMs + pauseMs).toISOString();
        this.deps.batchRepo.setWorkerState(STATE_CHUNK_PAUSE_UNTIL, resumeAtIso);
        this.deps.batchRepo.setWorkerState(STATE_CONSECUTIVE_SENT, String(nextCount));
        this.nextAllowedSendAtMs = nowMs + pauseMs;
        this.pauseReason = 'CHUNK_PAUSE';
        return;
      }
      this.deps.batchRepo.setWorkerState(STATE_CONSECUTIVE_SENT, String(nextCount));
    }

    this.nextAllowedSendAtMs = this.nextJitterSendAtMs;
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
