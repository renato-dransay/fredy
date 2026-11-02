/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../../../lib/services/storage/migrations/sql/61.ingestion-runs.js';
import {
  startIngestionRun,
  recoverInterruptedRuns,
  pruneRuns,
  MAX_COMPLETED_RUNS,
} from '../../../lib/services/ingestion/runMonitor.js';
import { ingestionStatus } from '../../../lib/services/ingestion/statusReport.js';

const NOW = Date.parse('2026-11-02T11:00:00Z');
let db, directory, filename;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'fredy-ingestion-'));
  filename = path.join(directory, 'history.db');
  db = new Database(filename);
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,name TEXT,enabled INTEGER,provider TEXT);
    CREATE TABLE settings(name TEXT,value TEXT,user_id TEXT);
    INSERT INTO jobs VALUES('job','Search',1,'[{"id":"api"},{"id":"browser"},{"id":"off","enabled":false}]');
    INSERT INTO settings VALUES('interval','5',NULL);`);
  up(db);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});
const row = () => db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();

describe('persistent provider receipts', () => {
  it('persists counts, terminal outcome and stage across reopening read-only', () => {
    let now = NOW;
    const run = startIngestionRun('job', 'api', db, () => now);
    run.stage('fetch');
    run.count('fetched', 12);
    run.stage('save');
    run.count('stored', 3);
    run.count('matched', 2);
    run.stage('notify');
    now += 1200;
    run.finish();
    run.finish();
    db.close();
    db = new Database(filename, { readonly: true });
    expect(row()).toMatchObject({
      outcome: 'success',
      stage: 'notify',
      fetched: 12,
      stored: 3,
      matched: 2,
      started_at: NOW,
      finished_at: NOW + 1200,
    });
    expect(db.prepare('SELECT COUNT(*) n FROM ingestion_runs').get().n).toBe(1);
  });

  it('keeps incomplete search responses failed even if the pipeline stops with no-new', () => {
    const run = startIngestionRun('job', 'api', db, () => NOW);
    run.stage('fetch');
    run.incomplete();
    run.count('fetched', 4);
    run.count('stored', 2);
    run.stage('findNew');
    run.noNew();
    run.finish();
    expect(row()).toMatchObject({
      outcome: 'failed',
      error_category: 'provider_incomplete',
      stage: 'fetch',
      stored: 2,
    });
  });

  it.each([
    [401, 'access_denied'],
    [403, 'access_denied'],
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
    [400, 'provider_incomplete'],
    [undefined, 'provider_incomplete'],
    ['secret', 'provider_incomplete'],
  ])('retains a safe category for incomplete HTTP status %s', (status, expected) => {
    const run = startIngestionRun('job', 'api', db, () => NOW);
    run.stage('fetch');
    run.incomplete(status);
    run.noNew();
    run.finish();
    expect(row()).toMatchObject({ outcome: 'failed', stage: 'fetch', error_category: expected });
    expect(JSON.stringify(row())).not.toContain('secret');
  });

  it('records only a safe error category, never secret exception payloads', () => {
    const run = startIngestionRun('job', 'browser', db, () => NOW);
    run.stage('browser');
    run.failed(Object.assign(new Error('secret https://user:pass@example/?token=secret'), { status: 403 }));
    run.finish();
    expect(row()).toMatchObject({ outcome: 'failed', stage: 'browser', error_category: 'access_denied' });
    expect(JSON.stringify(row())).not.toContain('secret');
  });

  it('read-only reporting preserves running receipts, startup alone recovers them', () => {
    startIngestionRun('job', 'api', db, () => NOW);
    db.close();
    db = new Database(filename, { readonly: true });
    expect(ingestionStatus(db, { now: NOW }).providers[0].health).toBe('running');
    expect(row().outcome).toBe('running');
    db.close();
    db = new Database(filename);
    recoverInterruptedRuns(db, NOW + 1000);
    expect(row()).toMatchObject({ outcome: 'interrupted', error_category: 'process_restart', finished_at: NOW + 1000 });
  });

  it('continues safely when receipt storage cannot be written', () => {
    db.close();
    db = new Database(filename, { readonly: true });
    expect(() => {
      const run = startIngestionRun('job', 'api', db);
      run.stage('fetch');
      run.failed(new Error('upstream'));
      run.noNew();
      run.finish();
      recoverInterruptedRuns(db);
    }).not.toThrow();
  });

  it('bounds completed history by age and count but preserves running records', () => {
    const insert = db.prepare(`INSERT INTO ingestion_runs(job_id,provider,started_at,finished_at,outcome,stage)
      VALUES('job','api',?,?,'success','notify')`);
    db.transaction(() => {
      for (let i = 0; i < MAX_COMPLETED_RUNS + 2; i++) insert.run(NOW + i, NOW + i);
    })();
    startIngestionRun('job', 'browser', db, () => NOW - 40 * 86_400_000);
    insert.run(NOW - 40 * 86_400_000, NOW - 40 * 86_400_000);
    pruneRuns(db, NOW);
    expect(db.prepare("SELECT COUNT(*) n FROM ingestion_runs WHERE outcome='success'").get().n).toBe(
      MAX_COMPLETED_RUNS,
    );
    expect(db.prepare("SELECT COUNT(*) n FROM ingestion_runs WHERE outcome='running'").get().n).toBe(1);
    db.prepare("DELETE FROM jobs WHERE id='job'").run();
    expect(db.prepare('SELECT COUNT(*) n FROM ingestion_runs').get().n).toBe(0);
  });
});

describe('ingestion status', () => {
  it('includes never-run providers, ignores disabled providers and marks hanging runs overdue', () => {
    startIngestionRun('job', 'api', db, () => NOW - 16 * 60_000);
    const report = ingestionStatus(db, { now: NOW });
    expect(report.providers.map(({ provider, health }) => ({ provider, health }))).toEqual([
      { provider: 'api', health: 'overdue' },
      { provider: 'browser', health: 'no_history' },
    ]);
  });

  it('does not report old runs overdue outside configured working hours', () => {
    db.prepare('INSERT INTO settings VALUES(?,?,NULL)').run(
      'workingHours',
      JSON.stringify({ from: '15:00', to: '17:00', timeZone: 'Europe/Berlin' }),
    );
    const run = startIngestionRun('job', 'api', db, () => NOW - 60 * 60_000);
    run.noNew();
    run.finish();
    expect(ingestionStatus(db, { now: NOW }).providers[0].health).toBe('ok');
  });

  it('reports nonfatal enrichment failures as degraded with 24-hour totals', () => {
    const run = startIngestionRun('job', 'api', db, () => NOW);
    run.warning();
    run.count('stored', 2);
    run.finish();
    expect(ingestionStatus(db, { now: NOW }).providers[0]).toMatchObject({
      health: 'degraded',
      last24h: { runs: 1, stored: 2, warnings: 1 },
    });
  });
});
