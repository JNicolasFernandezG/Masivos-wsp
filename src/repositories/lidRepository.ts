import { toPlainRow, type SqliteDb } from '../db/database.js';

export interface LidMappingRecord {
  lid: string;
  phone_jid: string;
  phone_number: string;
  updated_at: string;
}

export class LidRepository {
  constructor(private readonly db: SqliteDb) {}

  findByLid(lid: string): LidMappingRecord | null {
    const row = this.db
      .prepare('SELECT lid, phone_jid, phone_number, updated_at FROM lid_mappings WHERE lid = ?')
      .get(lid) as Record<string, unknown> | undefined;
    return row ? (toPlainRow(row) as unknown as LidMappingRecord) : null;
  }

  upsert(lid: string, phoneJid: string, phoneNumber: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lid_mappings (lid, phone_jid, phone_number, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(lid) DO UPDATE SET
           phone_jid = excluded.phone_jid,
           phone_number = excluded.phone_number,
           updated_at = excluded.updated_at`
      )
      .run(lid, phoneJid, phoneNumber, now);
  }
}
