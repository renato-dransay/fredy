/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

/**
 * Quiesce browser automation before a deployment snapshot. Expired browser leases do not prove a
 * submission failed or a profile closed. Uncertain receipts and unacknowledged server browsers
 * therefore remain blockers until reconciled or disconnected explicitly. Never mutates receipts.
 * The deployment worker embeds the same operation so it also runs in pre-feature images.
 * @param {import('better-sqlite3').Database} db
 * @param {'request'|'status'|'release'} command
 * @param {number} [now]
 * @returns {{supported:boolean,draining:boolean,active:number,uncertain:number,profilesPending:number,safe:boolean}}
 */
export function drainState(db, command, now = Date.now()) {
  if (!['request', 'status', 'release'].includes(command)) throw new Error('Choose request, status or release.');
  return db
    .transaction(() => {
      const tables = ['auto_apply_control', 'auto_apply_runs', 'auto_apply_receipts', 'auto_apply_connections'];
      const present = tables.filter((name) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
      );
      if (!present.length)
        return { supported: false, draining: false, active: 0, uncertain: 0, profilesPending: 0, safe: true };
      if (present.length !== tables.length) throw new Error('Incomplete auto-apply schema; refusing deployment.');
      const control = db.prepare('SELECT draining FROM auto_apply_control WHERE id=1').get();
      if (!control) throw new Error('Missing auto-apply control; refusing deployment.');
      if (command === 'request' && control.draining !== 1) {
        db.prepare('UPDATE auto_apply_control SET draining=1 WHERE id=1').run();
        db.prepare("UPDATE auto_apply_connections SET drained_at=NULL WHERE mode='server' AND revoked=0").run();
      }
      if (command === 'release') db.prepare('UPDATE auto_apply_control SET draining=0 WHERE id=1').run();
      const draining = db.prepare('SELECT draining FROM auto_apply_control WHERE id=1').get().draining === 1;
      const active = db
        .prepare("SELECT COUNT(*) AS n FROM auto_apply_runs WHERE state='running' AND lease_until>?")
        .get(now).n;
      const uncertain = db
        .prepare(
          "SELECT COUNT(*) AS n FROM (SELECT id FROM auto_apply_runs WHERE state IN ('submitting','uncertain') UNION ALL SELECT run_id FROM auto_apply_receipts WHERE state IN ('submitting','uncertain'))",
        )
        .get().n;
      const profilesPending = db
        .prepare(
          "SELECT COUNT(*) AS n FROM auto_apply_connections WHERE mode='server' AND revoked=0 AND last_seen IS NOT NULL AND drained_at IS NULL",
        )
        .get().n;
      return {
        supported: true,
        draining,
        active,
        uncertain,
        profilesPending,
        safe: draining && active === 0 && uncertain === 0 && profilesPending === 0,
      };
    })
    .immediate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new Database(process.argv[3] || '/db/listings.db', { fileMustExist: true, timeout: 5000 });
  try {
    process.stdout.write(`${JSON.stringify(drainState(db, process.argv[2]))}\n`);
  } finally {
    db.close();
  }
}
