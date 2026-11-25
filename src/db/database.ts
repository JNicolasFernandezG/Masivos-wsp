import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export type SqliteDb = DatabaseSync;

function runMigrations(db: DatabaseSync): void {
  const columns = db
    .prepare('PRAGMA table_info(outbound_messages)')
    .all() as Array<{ name?: string }>;
  const hasChunkIndex = columns.some((c) => c.name === 'chunk_index');
  if (!hasChunkIndex) {
    db.exec('ALTER TABLE outbound_messages ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 1;');
  }
}

export function createDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    const dir = path.dirname(path.resolve(databasePath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

export function compactDatabase(db: DatabaseSync): boolean {
  try {
    const dbs = db.prepare('PRAGMA database_list').all() as Array<{ name?: string; file?: string }>;
    const mainDb = dbs.find((d) => d.name === 'main');
    if (!mainDb?.file) {
      return false;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    return true;
  } catch {
    return false;
  }
}

/**
 * Node's node:sqlite returns null-prototype row objects; copying into a standard
 * object ensures consistent serialization and prototype behavior.
 */
export function toPlainRow<T extends Record<string, unknown>>(row: T): T {
  return { ...row };
}

export function toPlainRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}
