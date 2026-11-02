/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';

export const RETENTION_DAYS = 30;
export const MAX_COMPLETED_RUNS = 20_000;

/**
 * Keep terminal receipts bounded. Running receipts are never removed; the sole application
 * scheduler marks them interrupted on its next startup. Called inside a caller's transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {number} now
 */
export function pruneRuns(db, now) {
  db.prepare('DELETE FROM ingestion_runs WHERE finished_at < ?').run(now - RETENTION_DAYS * 86_400_000);
  db.prepare(`DELETE FROM ingestion_runs WHERE id IN (
    SELECT id FROM ingestion_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT -1 OFFSET ?
  )`).run(MAX_COMPLETED_RUNS);
}

/**
 * Only call from main-process scheduler initialization, never a CLI, MCP reader or per-job run.
 * A process cannot finish its predecessor's in-flight provider runs; preserve that uncertainty.
 * @param {import('better-sqlite3').Database} [db]
 * @param {number} [now]
 */
export function recoverInterruptedRuns(db, now = Date.now()) {
  safe(() => {
    db ??= SqliteConnection.getConnection();
    db.transaction(() => {
      db.prepare(`UPDATE ingestion_runs SET outcome='interrupted', finished_at=?, error_category='process_restart'
        WHERE outcome='running'`).run(now);
      pruneRuns(db, now);
    })();
  });
}

/** Avoid persisting arbitrary exception messages, URLs, response bodies, or credentials. */
function category(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timed?\s*out/i.test(error?.message ?? ''))
    return 'timeout';
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'access_denied';
  if (status >= 500 && status <= 599) return 'upstream_error';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'network';
  return 'error';
}

/** Monitoring failures must never block ingestion or print database contents/error payloads. */
function safe(operation) {
  try {
    return operation();
  } catch {
    logger.warn('Persistent ingestion monitoring could not write a run receipt.');
    return undefined;
  }
}

/**
 * Start a receipt before provider setup/browser launch. Methods accept only internal stage names
 * and numbers. A provider's partial result can be saved while its receipt remains failed.
 * @param {string} jobId
 * @param {string} provider
 * @param {import('better-sqlite3').Database} [db]
 * @param {() => number} [clock]
 * @returns {{stage: Function, count: Function, warning: Function, incomplete: Function, failed: Function,
 * noNew: Function, finish: Function}}
 */
export function startIngestionRun(jobId, provider, db, clock = Date.now) {
  let runId;
  const state = { stage: 'setup', fetched: 0, stored: 0, matched: 0, warnings: 0, error_category: null };
  let outcome = 'success';
  let failureStage;
  let finished = false;
  safe(() => {
    db ??= SqliteConnection.getConnection();
    runId = Number(
      db
        .prepare(`INSERT INTO ingestion_runs(job_id,provider,started_at,outcome,stage)
      VALUES(?,?,?,'running','setup')`)
        .run(jobId, provider, clock()).lastInsertRowid,
    );
  });
  return {
    stage(name) {
      state.stage = name;
    },
    count(name, value) {
      if (['fetched', 'stored', 'matched'].includes(name) && Number.isFinite(value))
        state[name] = Math.max(0, Math.floor(value));
    },
    warning() {
      state.warnings++;
    },
    /** @param {number|undefined} status HTTP status only; arbitrary error text is never retained. */
    incomplete(status) {
      outcome = 'failed';
      failureStage = state.stage;
      const reason = category({ status: typeof status === 'number' ? status : undefined });
      state.error_category = reason === 'error' ? 'provider_incomplete' : reason;
    },
    failed(error) {
      outcome = 'failed';
      failureStage = state.stage;
      state.error_category = category(error);
    },
    noNew() {
      if (outcome !== 'failed') outcome = 'no_new';
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!runId) return;
      safe(() =>
        db.transaction(() => {
          db.prepare(`UPDATE ingestion_runs SET finished_at=@finished_at,outcome=@outcome,
          stage=@stage,fetched=@fetched,stored=@stored,matched=@matched,warnings=@warnings,
          error_category=@error_category WHERE id=@id AND outcome='running'`).run({
            ...state,
            stage: failureStage ?? state.stage,
            finished_at: clock(),
            outcome,
            id: runId,
          });
          pruneRuns(db, clock());
        })(),
      );
    },
  };
}
