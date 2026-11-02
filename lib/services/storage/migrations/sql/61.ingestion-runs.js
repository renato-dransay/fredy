/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Durable, bounded provider-run receipts; deleting a job also deletes its history. */
export function up(db) {
  db.exec(`
    CREATE TABLE ingestion_runs (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT NOT NULL CHECK(outcome IN ('running','success','no_new','failed','interrupted')),
      stage TEXT NOT NULL,
      fetched INTEGER NOT NULL DEFAULT 0,
      stored INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      error_category TEXT
    );
    CREATE INDEX ingestion_runs_job_provider ON ingestion_runs(job_id, provider, id DESC);
    CREATE INDEX ingestion_runs_finished ON ingestion_runs(finished_at);
  `);
}
