/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Add private browser automation state. Receipts deliberately outlive the source advert. */
export function up(db) {
  db.exec(`
    CREATE TABLE auto_apply_rules (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL, since INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL,
      PRIMARY KEY(user_id,job_id)
    );
    CREATE TABLE auto_apply_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      portal TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      control_mode TEXT NOT NULL DEFAULT 'human', status TEXT NOT NULL DEFAULT 'disconnected',
      account_identity TEXT, qualified INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, drained_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE applicant_documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      hash TEXT NOT NULL, created_at INTEGER NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE auto_apply_runs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT, listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      generation TEXT NOT NULL, portal TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending_assessment', reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
      connection_id TEXT, lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      advert_key TEXT, snapshot TEXT, receipt TEXT, authorization_hash TEXT,
      authorization_until INTEGER, consumed INTEGER NOT NULL DEFAULT 0, usage TEXT,
      UNIQUE(user_id,listing_id)
    );
    CREATE INDEX auto_apply_queue ON auto_apply_runs(state,available_at);
    CREATE INDEX auto_apply_adverts ON auto_apply_runs(user_id,advert_key);
    CREATE TABLE auto_apply_receipts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      advert_key TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL,
      snapshot TEXT NOT NULL, evidence TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,advert_key)
    );
    CREATE TABLE auto_apply_control (id INTEGER PRIMARY KEY CHECK(id=1), draining INTEGER NOT NULL DEFAULT 0);
    INSERT INTO auto_apply_control(id) VALUES(1);
    CREATE TRIGGER auto_apply_discovery AFTER INSERT ON listings BEGIN
      INSERT OR IGNORE INTO auto_apply_runs
        (id,user_id,job_id,listing_id,generation,portal,origin,created_at,updated_at,available_at)
      SELECT lower(hex(randomblob(16))),r.user_id,NEW.job_id,NEW.id,r.generation,NEW.provider,
        CASE WHEN NEW.added_manually=1 THEN 'manual' ELSE 'search' END,
        NEW.created_at,NEW.created_at,NEW.created_at+30000
      FROM auto_apply_rules r WHERE r.job_id=NEW.job_id AND r.enabled=1 AND NEW.created_at>=r.since
        AND NEW.provider IN (SELECT value FROM json_each(r.config,'$.portals'));
    END;
  `);
}
