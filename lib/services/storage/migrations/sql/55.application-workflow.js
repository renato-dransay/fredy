/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Add private application records, durable delivery receipts, and mailbox cursors. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_records (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft', recipient TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      visit_at TEXT, follow_up_at TEXT, auto_send_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      UNIQUE(user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS application_records_due ON application_records(auto_send_at);
    CREATE TABLE IF NOT EXISTS application_events (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES application_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
      dedup_key TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS application_sends (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      application_id TEXT NOT NULL, revision INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, idempotency_key), UNIQUE(application_id, revision)
    );
    CREATE TABLE IF NOT EXISTS application_mail (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL, uid_validity TEXT, last_uid INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT, last_sync_error TEXT
    );
  `);
}
