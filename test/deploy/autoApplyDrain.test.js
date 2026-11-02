/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const deployer = readFileSync(path.join(root, 'tools/deploy/mac_mini.py'), 'utf8');
const inlineScript = deployer.match(/^AUTO_APPLY_DRAIN_SCRIPT = r'''([\s\S]*?)^'''/m)?.[1];
if (!inlineScript) throw new Error('Cannot locate the actual deployed auto-apply drain script.');

// These checks belong in the Node test phase: the subsequent Python deployment checks run in a
// pristine host source snapshot, while Node dependencies are installed in the ARM64 check image.
const programs = [
  { name: 'inline deployer program', args: ['-e', inlineScript] },
  { name: 'standalone drain command', args: [path.join(root, 'tools/auto-apply/drain.js')] },
];

describe.each(programs)('$name', ({ args }) => {
  let directory, databasePath, db;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'fredy-drain-'));
    databasePath = path.join(directory, 'listings.db');
    db = new Database(databasePath);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** Run the production command in a separate process against the real fixture database. */
  const execute = (action) =>
    spawnSync(process.execPath, [...args, action, databasePath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
  /** A failed process or invalid output must fail the check, never stand in for a drain refusal. */
  const run = (action) => {
    const result = execute(action);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };

  it('preserves receipts and requires explicit profile closure before a snapshot', () => {
    expect(run('request')).toEqual({
      supported: false,
      draining: false,
      active: 0,
      uncertain: 0,
      profilesPending: 0,
      safe: true,
    });
    db.exec(`
      CREATE TABLE auto_apply_control(id INTEGER PRIMARY KEY,draining INTEGER);
      INSERT INTO auto_apply_control VALUES(1,0);
      CREATE TABLE auto_apply_runs(id TEXT,state TEXT,lease_until INTEGER);
      INSERT INTO auto_apply_runs VALUES('running','running',9000000000000),('send','submitting',1);
      CREATE TABLE auto_apply_receipts(run_id TEXT,state TEXT,snapshot TEXT);
      INSERT INTO auto_apply_receipts VALUES('deleted-run','uncertain','private immutable snapshot');
      CREATE TABLE auto_apply_connections(id TEXT,mode TEXT,revoked INTEGER,last_seen INTEGER,drained_at INTEGER);
      INSERT INTO auto_apply_connections VALUES('server','server',0,1,123),('desktop','desktop',0,1,NULL),('revoked','server',1,1,NULL);
    `);
    const status = run('request');
    expect([status.active, status.uncertain, status.profilesPending, status.safe]).toEqual([1, 2, 1, false]);
    db.exec("UPDATE auto_apply_connections SET drained_at=456 WHERE id='server'");
    expect(run('request').profilesPending).toBe(0);
    expect(run('release').draining).toBe(false);
    expect(db.prepare('SELECT state,snapshot FROM auto_apply_receipts').all()).toEqual([
      { state: 'uncertain', snapshot: 'private immutable snapshot' },
    ]);
    db.exec(`
      UPDATE auto_apply_runs SET state='submitted' WHERE id='send';
      UPDATE auto_apply_runs SET lease_until=1 WHERE id='running';
      UPDATE auto_apply_receipts SET state='submitted';
    `);
    expect(run('request').safe).toBe(false);
    db.exec("UPDATE auto_apply_connections SET drained_at=789 WHERE id='server'");
    expect(run('status').safe).toBe(true);
    expect(run('release').draining).toBe(false);
  });

  it('refuses an incomplete schema instead of treating it as a pre-feature installation', () => {
    db.exec('CREATE TABLE auto_apply_control(id INTEGER PRIMARY KEY,draining INTEGER)');
    const result = execute('request');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Incomplete auto-apply schema; refusing deployment');
  });
});
