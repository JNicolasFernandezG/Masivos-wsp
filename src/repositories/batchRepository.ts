import { compactDatabase, toPlainRow, toPlainRows, type SqliteDb } from '../db/database.js';

export type BatchStatus =
  | 'PENDIENTE'
  | 'EN_PROCESO'
  | 'PAUSADO'
  | 'COMPLETADO'
  | 'COMPLETADO_CON_ERRORES'
  | 'CANCELADO';

export type OutboundStatus =
  | 'PENDIENTE'
  | 'PROCESANDO'
  | 'ENVIADO'
  | 'ERROR'
  | 'CANCELADO';

export interface BatchRecord {
  id: number;
  name: string;
  source: string;
  template: string | null;
  total_count: number;
  status: BatchStatus;
  created_at: string;
  updated_at: string;
}

export interface BatchWithStats extends BatchRecord {
  pending_count: number;
  processing_count: number;
  sent_count: number;
  error_count: number;
  cancelled_count: number;
}

export interface OutboundMessageRecord {
  id: number;
  batch_id: number;
  chunk_index: number;
  recipient_raw: string;
  phone_normalized: string | null;
  chat_id: string;
  variables_json: string;
  rendered_text: string;
  status: OutboundStatus;
  attempts: number;
  waha_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewOutboundItem {
  chunkIndex?: number;
  recipientRaw: string;
  phoneNormalized: string | null;
  chatId: string;
  variables: Record<string, string>;
  renderedText: string;
}

export interface CreateBatchInput {
  name: string;
  source: 'web_file' | 'web_manual' | 'api';
  template: string | null;
  items: NewOutboundItem[];
}

export interface ClearFinishedBatchesResult {
  deletedBatches: number;
  deletedMessages: number;
  remainingBatches: number;
  preservedSentToday: number;
}

const STATE_DAILY_SENT_DATE = 'daily_sent_date';
const STATE_DAILY_SENT_PRESERVED = 'daily_sent_preserved';

export class BatchRepository {
  constructor(private readonly db: SqliteDb) {}

  createBatch(input: CreateBatchInput): BatchWithStats {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertBatch = this.db.prepare(
        `INSERT INTO batches (name, source, template, total_count, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDIENTE', ?, ?)`
      );
      const batchResult = insertBatch.run(
        input.name,
        input.source,
        input.template,
        input.items.length,
        now,
        now
      );
      const batchId = Number(batchResult.lastInsertRowid);

      const insertItem = this.db.prepare(
        `INSERT INTO outbound_messages (
          batch_id, chunk_index, recipient_raw, phone_normalized, chat_id, variables_json,
          rendered_text, status, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', 0, ?, ?)`
      );

      for (const item of input.items) {
        insertItem.run(
          batchId,
          item.chunkIndex ?? 1,
          item.recipientRaw,
          item.phoneNormalized,
          item.chatId,
          JSON.stringify(item.variables),
          item.renderedText,
          now,
          now
        );
      }

      this.db.exec('COMMIT');
      const created = this.getBatchById(batchId);
      if (!created) {
        throw new Error('No se pudo recuperar el lote recién creado.');
      }
      return created;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listBatches(limit = 50): BatchWithStats[] {
    const rows = this.db
      .prepare(
        `SELECT
          b.*,
          COALESCE(SUM(CASE WHEN m.status = 'PENDIENTE' THEN 1 ELSE 0 END), 0) AS pending_count,
          COALESCE(SUM(CASE WHEN m.status = 'PROCESANDO' THEN 1 ELSE 0 END), 0) AS processing_count,
          COALESCE(SUM(CASE WHEN m.status = 'ENVIADO' THEN 1 ELSE 0 END), 0) AS sent_count,
          COALESCE(SUM(CASE WHEN m.status = 'ERROR' THEN 1 ELSE 0 END), 0) AS error_count,
          COALESCE(SUM(CASE WHEN m.status = 'CANCELADO' THEN 1 ELSE 0 END), 0) AS cancelled_count
        FROM batches b
        LEFT JOIN outbound_messages m ON m.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.id DESC
        LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return toPlainRows(rows) as unknown as BatchWithStats[];
  }

  getBatchById(batchId: number): BatchWithStats | null {
    const row = this.db
      .prepare(
        `SELECT
          b.*,
          COALESCE(SUM(CASE WHEN m.status = 'PENDIENTE' THEN 1 ELSE 0 END), 0) AS pending_count,
          COALESCE(SUM(CASE WHEN m.status = 'PROCESANDO' THEN 1 ELSE 0 END), 0) AS processing_count,
          COALESCE(SUM(CASE WHEN m.status = 'ENVIADO' THEN 1 ELSE 0 END), 0) AS sent_count,
          COALESCE(SUM(CASE WHEN m.status = 'ERROR' THEN 1 ELSE 0 END), 0) AS error_count,
          COALESCE(SUM(CASE WHEN m.status = 'CANCELADO' THEN 1 ELSE 0 END), 0) AS cancelled_count
        FROM batches b
        LEFT JOIN outbound_messages m ON m.batch_id = b.id
        WHERE b.id = ?
        GROUP BY b.id`
      )
      .get(batchId) as Record<string, unknown> | undefined;

    return row ? (toPlainRow(row) as unknown as BatchWithStats) : null;
  }

  getBatchMessages(batchId: number): OutboundMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbound_messages
         WHERE batch_id = ?
         ORDER BY id ASC`
      )
      .all(batchId) as Record<string, unknown>[];
    return toPlainRows(rows) as unknown as OutboundMessageRecord[];
  }

  countSentSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM outbound_messages
         WHERE status = 'ENVIADO' AND sent_at IS NOT NULL AND sent_at >= ?`
      )
      .get(sinceIso) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  getLastSentMessage(): {
    id: number;
    batch_id: number;
    chunk_index: number;
    sent_at: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, batch_id, chunk_index, sent_at
         FROM outbound_messages
         WHERE status = 'ENVIADO' AND sent_at IS NOT NULL
         ORDER BY sent_at DESC, id DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    return row
      ? (toPlainRow(row) as unknown as {
          id: number;
          batch_id: number;
          chunk_index: number;
          sent_at: string;
        })
      : null;
  }

  getWorkerState(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM worker_state WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setWorkerState(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM worker_state WHERE key = ?').run(key);
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO worker_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  recoverStuckProcessing(): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE outbound_messages
         SET status = 'PENDIENTE', updated_at = ?
         WHERE status = 'PROCESANDO'`
      )
      .run(now);
    return Number(res.changes);
  }

  findNextPendingMessage(): OutboundMessageRecord | null {
    const row = this.db
      .prepare(
        `SELECT m.*
         FROM outbound_messages m
         INNER JOIN batches b ON b.id = m.batch_id
         WHERE m.status = 'PENDIENTE'
           AND b.status IN ('PENDIENTE', 'EN_PROCESO')
         ORDER BY m.id ASC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    return row ? (toPlainRow(row) as unknown as OutboundMessageRecord) : null;
  }

  claimMessageForProcessing(messageId: number): OutboundMessageRecord | null {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db
        .prepare(
          `UPDATE outbound_messages
           SET status = 'PROCESANDO', attempts = attempts + 1, updated_at = ?
           WHERE id = ?
             AND status = 'PENDIENTE'
             AND EXISTS (
               SELECT 1 FROM batches b
               WHERE b.id = outbound_messages.batch_id
                 AND b.status IN ('PENDIENTE', 'EN_PROCESO')
             )`
        )
        .run(now, messageId);

      if (Number(updated.changes) === 0) {
        this.db.exec('COMMIT');
        return null;
      }

      const row = this.db
        .prepare('SELECT * FROM outbound_messages WHERE id = ?')
        .get(messageId) as Record<string, unknown>;

      const plain = toPlainRow(row) as unknown as OutboundMessageRecord;
      this.db
        .prepare(
          `UPDATE batches
           SET status = 'EN_PROCESO', updated_at = ?
           WHERE id = ? AND status = 'PENDIENTE'`
        )
        .run(now, plain.batch_id);

      this.db.exec('COMMIT');
      return plain;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markMessageSent(messageId: number, wahaMessageId: string | null): OutboundMessageRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE outbound_messages
         SET status = 'ENVIADO',
             waha_message_id = ?,
             error_message = NULL,
             sent_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(wahaMessageId, now, now, messageId);

    const row = this.db
      .prepare('SELECT * FROM outbound_messages WHERE id = ?')
      .get(messageId) as Record<string, unknown>;
    return toPlainRow(row) as unknown as OutboundMessageRecord;
  }

  markMessageError(messageId: number, errorMessage: string): OutboundMessageRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE outbound_messages
         SET status = 'ERROR',
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(errorMessage.slice(0, 1000), now, messageId);

    const row = this.db
      .prepare('SELECT * FROM outbound_messages WHERE id = ?')
      .get(messageId) as Record<string, unknown>;
    return toPlainRow(row) as unknown as OutboundMessageRecord;
  }

  refreshBatchStatus(batchId: number): BatchWithStats | null {
    const batch = this.getBatchById(batchId);
    if (!batch) return null;

    if (batch.status === 'PAUSADO' || batch.status === 'CANCELADO') {
      return batch;
    }

    let nextStatus: BatchStatus = batch.status;
    if (batch.pending_count === 0 && batch.processing_count === 0) {
      if (batch.error_count > 0) {
        nextStatus = 'COMPLETADO_CON_ERRORES';
      } else if (batch.sent_count === 0 && batch.cancelled_count > 0) {
        nextStatus = 'CANCELADO';
      } else {
        nextStatus = 'COMPLETADO';
      }
    } else if (batch.sent_count > 0 || batch.error_count > 0 || batch.processing_count > 0) {
      nextStatus = 'EN_PROCESO';
    } else {
      nextStatus = 'PENDIENTE';
    }

    if (nextStatus !== batch.status) {
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, now, batchId);
      return this.getBatchById(batchId);
    }

    return batch;
  }

  pauseBatch(batchId: number): BatchWithStats | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE batches
         SET status = 'PAUSADO', updated_at = ?
         WHERE id = ? AND status IN ('PENDIENTE', 'EN_PROCESO')`
      )
      .run(now, batchId);
    return this.getBatchById(batchId);
  }

  resumeBatch(batchId: number): BatchWithStats | null {
    const batch = this.getBatchById(batchId);
    if (!batch) return null;
    if (batch.status !== 'PAUSADO') return batch;

    const now = new Date().toISOString();
    const targetStatus: BatchStatus =
      batch.sent_count > 0 || batch.error_count > 0 ? 'EN_PROCESO' : 'PENDIENTE';
    this.db
      .prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?')
      .run(targetStatus, now, batchId);
    return this.refreshBatchStatus(batchId);
  }

  cancelBatch(batchId: number): BatchWithStats | null {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE outbound_messages
           SET status = 'CANCELADO', updated_at = ?
           WHERE batch_id = ? AND status = 'PENDIENTE'`
        )
        .run(now, batchId);

      this.db
        .prepare(
          `UPDATE batches
           SET status = 'CANCELADO', updated_at = ?
           WHERE id = ? AND status NOT IN ('COMPLETADO', 'COMPLETADO_CON_ERRORES', 'CANCELADO')`
        )
        .run(now, batchId);

      this.db.exec('COMMIT');
      return this.getBatchById(batchId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  retryFailedMessages(batchId: number): BatchWithStats | null {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db
        .prepare(
          `UPDATE outbound_messages
           SET status = 'PENDIENTE', error_message = NULL, updated_at = ?
           WHERE batch_id = ? AND status = 'ERROR'`
        )
        .run(now, batchId);

      if (Number(res.changes) > 0) {
        this.db
          .prepare(
            `UPDATE batches
             SET status = 'EN_PROCESO', updated_at = ?
             WHERE id = ? AND status != 'PAUSADO'`
          )
          .run(now, batchId);
      }

      this.db.exec('COMMIT');
      return this.refreshBatchStatus(batchId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getPreservedDailySentCount(dateKey: string): number {
    const storedDate = this.getWorkerState(STATE_DAILY_SENT_DATE);
    if (storedDate !== dateKey) {
      return 0;
    }
    const raw = this.getWorkerState(STATE_DAILY_SENT_PRESERVED);
    const num = raw ? Number(raw) : 0;
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  }

  clearFinishedBatches(dateKey: string, startOfTodayIso: string): ClearFinishedBatchesResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deletableCondition = `
        batches.status IN ('COMPLETADO', 'COMPLETADO_CON_ERRORES', 'CANCELADO')
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages m2
          WHERE m2.batch_id = batches.id AND m2.status IN ('PENDIENTE', 'PROCESANDO')
        )
      `;

      const deletedMessagesRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM outbound_messages m
           INNER JOIN batches ON batches.id = m.batch_id
           WHERE ${deletableCondition}`
        )
        .get() as { cnt?: number } | undefined;
      const deletedMessages = Number(deletedMessagesRow?.cnt ?? 0);

      const deletedSentTodayRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM outbound_messages m
           INNER JOIN batches ON batches.id = m.batch_id
           WHERE ${deletableCondition}
             AND m.status = 'ENVIADO'
             AND m.sent_at IS NOT NULL
             AND m.sent_at >= ?`
        )
        .get(startOfTodayIso) as { cnt?: number } | undefined;
      const deletedSentToday = Number(deletedSentTodayRow?.cnt ?? 0);

      if (deletedSentToday > 0) {
        const existingPreserved = this.getPreservedDailySentCount(dateKey);
        this.setWorkerState(STATE_DAILY_SENT_DATE, dateKey);
        this.setWorkerState(STATE_DAILY_SENT_PRESERVED, String(existingPreserved + deletedSentToday));
      }

      const deletedBatchesRes = this.db
        .prepare(`DELETE FROM batches WHERE ${deletableCondition}`)
        .run();
      const deletedBatches = Number(deletedBatchesRes.changes);

      const remainingRow = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM batches')
        .get() as { cnt?: number } | undefined;
      const remainingBatches = Number(remainingRow?.cnt ?? 0);

      this.db.exec('COMMIT');
      return {
        deletedBatches,
        deletedMessages,
        remainingBatches,
        preservedSentToday: deletedSentToday,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  compact(): boolean {
    return compactDatabase(this.db);
  }
}
