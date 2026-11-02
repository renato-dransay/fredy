/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { duringWorkingHoursOrNotSet } from '../../utils.js';

/** Parse stored settings without importing writable storage or exposing unrelated settings. */
function decode(value, fallback = null) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Read the latest receipt for every enabled source, including ones that have never run. Staleness
 * uses the same working-hours predicate as the scheduler and allows three intervals or 15 minutes,
 * whichever is longer. A long-running provider is overdue too; its mere existence is not health.
 * Only observation is performed: this function never recovers, prunes or starts a run.
 * @param {import('better-sqlite3').Database} db A read-only connection is sufficient.
 * @param {{now?:number}} [options]
 * @returns {Object} JSON-safe operational report without search URLs or configuration secrets.
 */
export function ingestionStatus(db, { now = Date.now() } = {}) {
  const settings = Object.fromEntries(
    db
      .prepare(`SELECT name,value FROM settings
    WHERE user_id IS NULL AND name IN ('interval','workingHours')`)
      .all()
      .map(({ name, value }) => [name, decode(value)]),
  );
  const configuredInterval = Number(settings.interval);
  const intervalMinutes = Number.isFinite(configuredInterval) ? configuredInterval : 60;
  const scheduleActive = intervalMinutes > 0 && duringWorkingHoursOrNotSet(settings, now);
  const overdueAfterMs = Math.max(15, intervalMinutes * 3) * 60_000;
  const latest =
    db.prepare(`SELECT id,started_at,finished_at,outcome,stage,fetched,stored,matched,warnings,error_category
    FROM ingestion_runs WHERE job_id=? AND provider=? ORDER BY id DESC LIMIT 1`);
  const totals = db.prepare(`SELECT COUNT(*) runs,
    SUM(outcome IN ('success','no_new')) completed_ok, SUM(outcome='failed') failed,
    SUM(outcome='interrupted') interrupted, COALESCE(SUM(stored),0) stored,
    COALESCE(SUM(warnings),0) warnings FROM ingestion_runs
    WHERE job_id=? AND provider=? AND started_at>=?`);
  const providers = [];
  for (const job of db.prepare('SELECT id,name,provider FROM jobs WHERE enabled=1 ORDER BY id').all()) {
    const sources = decode(job.provider, []);
    for (const source of Array.isArray(sources) ? sources : []) {
      if (source.enabled === false) continue;
      const last = latest.get(job.id, source.id) ?? null;
      const ageMs = last ? Math.max(0, now - last.started_at) : null;
      let health = last?.outcome ?? 'no_history';
      if (scheduleActive && last && ageMs > overdueAfterMs) health = 'overdue';
      else if (['success', 'no_new'].includes(health)) health = last.warnings ? 'degraded' : 'ok';
      providers.push({
        jobId: job.id,
        jobName: job.name,
        provider: source.id,
        health,
        minutesSinceStart: ageMs == null ? null : Math.round(ageMs / 6000) / 10,
        latest: last,
        last24h: totals.get(job.id, source.id, now - 86_400_000),
      });
    }
  }
  return {
    observedAt: new Date(now).toISOString(),
    retentionDays: 30,
    maxCompletedRuns: 20_000,
    intervalMinutes,
    scheduleActive,
    overdueAfterMinutes: overdueAfterMs / 60_000,
    providers,
  };
}
