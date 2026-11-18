export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  template TEXT,
  total_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDIENTE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  recipient_raw TEXT NOT NULL,
  phone_normalized TEXT,
  chat_id TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '{}',
  rendered_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDIENTE',
  attempts INTEGER NOT NULL DEFAULT 0,
  waha_message_id TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_status_id
  ON outbound_messages (status, id);

CREATE INDEX IF NOT EXISTS idx_outbound_batch_status
  ON outbound_messages (batch_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waha_message_id TEXT UNIQUE,
  session_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT NOT NULL,
  raw_chat_id TEXT NOT NULL,
  sender_phone TEXT,
  sender_name TEXT,
  body TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'chat',
  has_media INTEGER NOT NULL DEFAULT 0,
  ack INTEGER,
  timestamp_unix INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time
  ON messages (chat_id, timestamp_unix DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_direction_time
  ON messages (direction, timestamp_unix DESC, id DESC);

CREATE TABLE IF NOT EXISTS lid_mappings (
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
