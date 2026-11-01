/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Add private apartment preferences and revision-bound assessments. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apartment_fit_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      document TEXT NOT NULL,
      criteria TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apartment_fit_results (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      evidence_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, listing_id)
    );
  `);
}
