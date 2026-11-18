import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export type SqliteDb = DatabaseSync;

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
  return db;
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
