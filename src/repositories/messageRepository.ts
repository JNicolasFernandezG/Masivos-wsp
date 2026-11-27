import { compactDatabase, toPlainRow, toPlainRows, type SqliteDb } from '../db/database.js';

export type MessageDirection = 'IN' | 'OUT';

export interface StoredMessageRecord {
  id: number;
  waha_message_id: string | null;
  session_name: string;
  event_type: string;
  direction: MessageDirection;
  from_me: number;
  chat_id: string;
  raw_chat_id: string;
  sender_phone: string | null;
  sender_name: string | null;
  body: string;
  message_type: string;
  has_media: number;
  ack: number | null;
  timestamp_unix: number;
  payload_json: string;
  created_at: string;
}

export interface ConversationSummary {
  chat_id: string;
  sender_phone: string | null;
  sender_name: string | null;
  last_body: string;
  last_direction: MessageDirection;
  last_timestamp: number;
  message_count: number;
}

export interface SaveMessageInput {
  wahaMessageId: string | null;
  sessionName: string;
  eventType: string;
  direction: MessageDirection;
  fromMe: boolean;
  chatId: string;
  rawChatId: string;
  senderPhone: string | null;
  senderName: string | null;
  body: string;
  messageType: string;
  hasMedia: boolean;
  ack: number | null;
  timestampUnix: number;
  payloadJson: string;
}

export class MessageRepository {
  constructor(private readonly db: SqliteDb) {}

  saveMessage(input: SaveMessageInput): { record: StoredMessageRecord; inserted: boolean } {
    const now = new Date().toISOString();

    if (input.wahaMessageId) {
      const existing = this.db
        .prepare('SELECT * FROM messages WHERE waha_message_id = ?')
        .get(input.wahaMessageId) as Record<string, unknown> | undefined;
      if (existing) {
        return {
          record: toPlainRow(existing) as unknown as StoredMessageRecord,
          inserted: false,
        };
      }
    }

    if (input.body.trim()) {
      const duplicateByContent = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE chat_id = ? AND from_me = ? AND timestamp_unix = ? AND body = ?
           LIMIT 1`
        )
        .get(
          input.chatId,
          input.fromMe ? 1 : 0,
          input.timestampUnix,
          input.body
        ) as Record<string, unknown> | undefined;
      if (duplicateByContent) {
        return {
          record: toPlainRow(duplicateByContent) as unknown as StoredMessageRecord,
          inserted: false,
        };
      }
    }

    const res = this.db
      .prepare(
        `INSERT INTO messages (
          waha_message_id, session_name, event_type, direction, from_me,
          chat_id, raw_chat_id, sender_phone, sender_name, body,
          message_type, has_media, ack, timestamp_unix, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.wahaMessageId,
        input.sessionName,
        input.eventType,
        input.direction,
        input.fromMe ? 1 : 0,
        input.chatId,
        input.rawChatId,
        input.senderPhone,
        input.senderName,
        input.body,
        input.messageType,
        input.hasMedia ? 1 : 0,
        input.ack,
        input.timestampUnix,
        input.payloadJson,
        now
      );

    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>;

    return {
      record: toPlainRow(row) as unknown as StoredMessageRecord,
      inserted: true,
    };
  }

  listMessages(options: {
    chatId?: string;
    direction?: MessageDirection;
    search?: string;
    limit?: number;
  } = {}): StoredMessageRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.chatId) {
      clauses.push('chat_id = ?');
      params.push(options.chatId);
    }
    if (options.direction) {
      clauses.push('direction = ?');
      params.push(options.direction);
    }
    if (options.search?.trim()) {
      const pattern = `%${options.search.trim()}%`;
      clauses.push('(body LIKE ? OR chat_id LIKE ? OR COALESCE(sender_name, \'\') LIKE ? OR COALESCE(sender_phone, \'\') LIKE ?)');
      params.push(pattern, pattern, pattern, pattern);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         ${whereSql}
         ORDER BY timestamp_unix DESC, id DESC
         LIMIT ?`
      )
      .all(...params) as Record<string, unknown>[];

    return toPlainRows(rows) as unknown as StoredMessageRecord[];
  }

  listConversations(limit = 50): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `WITH ranked AS (
          SELECT
            m.*,
            ROW_NUMBER() OVER (
              PARTITION BY m.chat_id
              ORDER BY m.timestamp_unix DESC, m.id DESC
            ) AS rn,
            COUNT(*) OVER (PARTITION BY m.chat_id) AS message_count
          FROM messages m
        )
        SELECT
          r.chat_id,
          (
            SELECT m2.sender_phone FROM messages m2
            WHERE m2.chat_id = r.chat_id AND m2.sender_phone IS NOT NULL
            ORDER BY m2.timestamp_unix DESC, m2.id DESC LIMIT 1
          ) AS sender_phone,
          (
            SELECT m2.sender_name FROM messages m2
            WHERE m2.chat_id = r.chat_id AND m2.sender_name IS NOT NULL AND m2.from_me = 0
            ORDER BY m2.timestamp_unix DESC, m2.id DESC LIMIT 1
          ) AS sender_name,
          r.body AS last_body,
          r.direction AS last_direction,
          r.timestamp_unix AS last_timestamp,
          r.message_count AS message_count
        FROM ranked r
        WHERE r.rn = 1
        ORDER BY r.timestamp_unix DESC, r.id DESC
        LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return toPlainRows(rows) as unknown as ConversationSummary[];
  }

  clearAllMessages(): { deletedMessages: number } {
    const res = this.db.prepare('DELETE FROM messages').run();
    return { deletedMessages: Number(res.changes) };
  }

  compact(): boolean {
    return compactDatabase(this.db);
  }
}
