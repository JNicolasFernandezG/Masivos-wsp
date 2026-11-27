import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { BatchRepository, OutboundMessageRecord } from '../repositories/batchRepository.js';
import {
  checkBusinessHours,
  getLocalClock,
  getNextBusinessDayStart,
  getStartOfLocalDayUtc,
} from '../services/businessHours.js';
import type { EventBus } from '../services/eventBus.js';
import type { WahaClient } from '../services/wahaClient.js';

export type WorkerPauseReason =
  | 'NONE'
  | 'MANUAL_PAUSE'
  | 'MESSAGE_JITTER'
  | 'CHUNK_PAUSE'
  | 'DAILY_LIMIT_REACHED'
  | 'OUTSIDE_HOURS'
  | 'NON_BUSINESS_DAY'
  | 'SESSION_NOT_READY'
  | 'SESSION_WARMUP';

export interface WorkerRuntimeStatus {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  manualPaused: boolean;
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
  sessionWarmupMs: number;
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
const STATE_SESSION_WARMUP_UNTIL = 'session_warmup_until';
const STATE_MANUAL_PAUSED = 'manual_paused';

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

/**
 * Generates all unique delays (in ms) resulting from multiplying two prime numbers (p * q seconds)
 * within [minDelayMs, maxDelayMs].
 */
export function getPrimeProductDelaysMs(minDelayMs: number, maxDelayMs: number): number[] {
  if (maxDelayMs <= 0 || maxDelayMs < minDelayMs) return [];
  const minSec = Math.max(4, Math.ceil(minDelayMs / 1000));
  const maxSec = Math.floor(maxDelayMs / 1000);
  if (maxSec < minSec) return [];

  const maxPrime = Math.floor(maxSec / 2);
  const primes: number[] = [];
  for (let n = 2; n <= maxPrime; n += 1) {
    if (isPrime(n)) {
      primes.push(n);
    }
  }

  const products = new Set<number>();
  for (let i = 0; i < primes.length; i += 1) {
    for (let j = i; j < primes.length; j += 1) {
      const prod = primes[i] * primes[j];
      if (prod > maxSec) break;
      if (prod >= minSec) {
        products.add(prod * 1000);
      }
    }
  }

  return Array.from(products).sort((a, b) => a - b);
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

function formatSendError(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Error desconocido enviando mensaje.';
  if (/recipient is not on whatsapp|no lid found/i.test(raw)) {
    return 'Número no registrado en WhatsApp (sin cuenta activa).';
  }
  return raw;
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
  private unsubscribeEvents: (() => void) | null = null;
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
    const nowDate = new Date(nowMs);
    const clock = getLocalClock(nowDate, this.deps.config.timezone);
    const startOfToday = getStartOfLocalDayUtc(nowDate, this.deps.config.timezone);
    return (
      this.deps.batchRepo.countSentSince(startOfToday.toISOString()) +
      this.deps.batchRepo.getPreservedDailySentCount(clock.dateKey)
    );
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

  private getSessionWarmupUntilMs(): number | null {
    const raw = this.deps.batchRepo.getWorkerState(STATE_SESSION_WARMUP_UNTIL);
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  private startSessionWarmup(nowMs: number): number {
    const warmupUntilMs = nowMs + this.deps.config.workerSessionWarmupMs;
    this.deps.batchRepo.setWorkerState(
      STATE_SESSION_WARMUP_UNTIL,
      new Date(warmupUntilMs).toISOString()
    );
    this.pauseReason = 'SESSION_WARMUP';
    this.nextAllowedSendAtMs = warmupUntilMs;
    this.emitStatus();
    return warmupUntilMs;
  }

  handleSessionStatusUpdate(newStatus: string): void {
    const prevStatus = this.sessionStatus;
    this.sessionStatus = newStatus;
    if (
      newStatus === 'WORKING' &&
      prevStatus !== 'WORKING' &&
      this.deps.config.workerSessionWarmupMs > 0
    ) {
      const nowMs = this.now();
      const existing = this.getSessionWarmupUntilMs();
      if (existing === null || existing <= nowMs) {
        this.startSessionWarmup(nowMs);
        return;
      }
    }
    this.emitStatus();
  }

  isManuallyPaused(): boolean {
    return this.deps.batchRepo.getWorkerState(STATE_MANUAL_PAUSED) === '1';
  }

  pauseAll(): WorkerRuntimeStatus {
    this.deps.batchRepo.setWorkerState(STATE_MANUAL_PAUSED, '1');
    this.pauseReason = 'MANUAL_PAUSE';
    this.nextAllowedSendAtMs = null;
    this.emitStatus();
    return this.getStatus();
  }

  resumeAll(): WorkerRuntimeStatus {
    this.deps.batchRepo.setWorkerState(STATE_MANUAL_PAUSED, null);
    if (this.pauseReason === 'MANUAL_PAUSE') {
      this.pauseReason = 'NONE';
    }
    this.emitStatus();
    return this.getStatus();
  }

  getStatus(): WorkerRuntimeStatus {
    const nowMs = this.now();
    const sentToday = this.getSentTodayCount(nowMs);
    const manualPaused = this.isManuallyPaused();
    const lastSent = this.lastSentAtMs
      ? new Date(this.lastSentAtMs).toISOString()
      : this.deps.batchRepo.getLastSentMessage()?.sent_at ?? null;

    return {
      enabled: this.deps.config.workerEnabled,
      running: this.running,
      busy: this.busy,
      manualPaused,
      sessionStatus: this.sessionStatus,
      pauseReason: manualPaused && !this.busy ? 'MANUAL_PAUSE' : this.pauseReason,
      sentToday,
      dailyLimit: this.deps.config.workerDailyLimit,
      chunkSize: this.deps.config.workerChunkSize,
      sentInCurrentChunk: this.getConsecutiveChunkCount(),
      businessHoursEnabled: this.deps.config.businessHoursEnabled,
      businessHoursWindow: `${this.deps.config.businessHoursStart}–${this.deps.config.businessHoursEnd}`,
      timezone: this.deps.config.timezone,
      lastSentAt: lastSent,
      nextSendAt:
        !manualPaused && this.nextAllowedSendAtMs && this.nextAllowedSendAtMs > nowMs
          ? new Date(this.nextAllowedSendAtMs).toISOString()
          : null,
      currentMessageId: this.currentMessageId,
      lastError: this.lastError,
      minDelayMs: this.deps.config.workerMinDelayMs,
      maxDelayMs: this.deps.config.workerMaxDelayMs,
      sessionWarmupMs: this.deps.config.workerSessionWarmupMs,
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
    this.unsubscribeEvents = this.deps.eventBus.subscribe((event) => {
      if (event.type !== 'session.status' || !event.data || typeof event.data !== 'object') {
        return;
      }
      const data = event.data as { session?: unknown; status?: unknown };
      if (
        typeof data.session === 'string' &&
        data.session !== this.deps.config.wahaSession
      ) {
        return;
      }
      if (typeof data.status === 'string') {
        this.handleSessionStatusUpdate(data.status);
      }
    });
    this.emitStatus();
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
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

    // 0. Global manual pause check
    if (this.isManuallyPaused()) {
      this.pauseReason = 'MANUAL_PAUSE';
      this.nextAllowedSendAtMs = null;
      this.emitStatus();
      return false;
    }

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

    // 3.5. Persistent post-connection session warm-up check
    let justFinishedWarmup = false;
    const sessionWarmupUntilMs = this.getSessionWarmupUntilMs();
    if (sessionWarmupUntilMs !== null) {
      if (sessionWarmupUntilMs > nowMs) {
        this.pauseReason = 'SESSION_WARMUP';
        this.nextAllowedSendAtMs = sessionWarmupUntilMs;
        this.emitStatus();
        await this.sleepUntilOrSlice(sessionWarmupUntilMs, abortSignal);
        return false;
      }
      this.deps.batchRepo.setWorkerState(STATE_SESSION_WARMUP_UNTIL, null);
      justFinishedWarmup = true;
    }

    // 4. Per-message randomized prime-product delay
    if (this.nextJitterSendAtMs !== null && this.nextJitterSendAtMs > nowMs) {
      this.pauseReason = 'MESSAGE_JITTER';
      this.nextAllowedSendAtMs = this.nextJitterSendAtMs;
      this.emitStatus();
      await this.sleep(this.nextJitterSendAtMs - nowMs, abortSignal);
      if (abortSignal.aborted) return false;
    }

    // Re-check manual pause, business hours and pending message after sleeping
    if (this.isManuallyPaused()) {
      this.pauseReason = 'MANUAL_PAUSE';
      this.nextAllowedSendAtMs = null;
      this.emitStatus();
      return false;
    }

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
    const prevSessionStatus = this.sessionStatus;
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

    // Trigger post-connection warm-up when session transitions into WORKING
    if (
      !justFinishedWarmup &&
      prevSessionStatus !== 'WORKING' &&
      this.deps.config.workerSessionWarmupMs > 0
    ) {
      const warmupUntilMs = this.startSessionWarmup(this.now());
      await this.sleepUntilOrSlice(warmupUntilMs, abortSignal);
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
      const errMsg = formatSendError(err);
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

  private computeNextMessageDelayMs(): number {
    const minMs = this.deps.config.workerMinDelayMs;
    const maxMs = this.deps.config.workerMaxDelayMs;
    const primeProducts = getPrimeProductDelaysMs(minMs, maxMs);
    if (primeProducts.length > 0) {
      const idx = this.randomInt(0, primeProducts.length - 1);
      const safeIdx = Math.max(0, Math.min(primeProducts.length - 1, idx));
      return primeProducts[safeIdx];
    }
    return this.randomInt(minMs, maxMs);
  }

  private scheduleAfterSend(succeeded: boolean): void {
    const nowMs = this.now();
    const jitterMs = this.computeNextMessageDelayMs();
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
