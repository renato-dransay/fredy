/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { summarizeFit } from '../../lib/services/fit/evaluate.js';
import { sortByFit } from '../../ui/src/services/listings/fitPresentation.js';
import { up } from '../../lib/services/storage/migrations/sql/60.restore-weighted-fit.js';

/** Replay all exported saved assessments through the repair in memory; no inference or live writes. */
let rows;
try {
  rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch {
  throw new Error('Expected a complete JSON export of saved assessments.');
}
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE apartment_fit_results(user_id TEXT,listing_id TEXT,result TEXT)');
  const insert = db.prepare('INSERT INTO apartment_fit_results VALUES (?,?,?)');
  rows.forEach((r) => insert.run(r.user_id, r.listing_id, r.result));
  up(db);
  const repaired = db.prepare('SELECT * FROM apartment_fit_results').all();
  const candidates = repaired.map((r, index) => {
    const before = JSON.parse(rows[index].result);
    const after = JSON.parse(r.result);
    assert.deepEqual(after, { ...before, score: summarizeFit(before.criteria).score });
    const hasMatch = before.criteria.some((c) => c.verdict === 'met' && c.weight > 0);
    assert.equal(after.score > 0, hasMatch);
    return { ...rows[index], id: r.listing_id, fitSummary: after };
  });
  for (const userId of new Set(rows.map((r) => r.user_id))) {
    for (const direction of ['asc', 'desc']) {
      const sorted = sortByFit(
        candidates.filter((r) => r.user_id === userId),
        direction,
      );
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1].fitSummary;
        const b = sorted[i].fitSummary;
        assert.ok(!a.hardFailure || b.hardFailure);
        if (a.hardFailure === b.hardFailure) assert.ok(direction === 'desc' ? a.score >= b.score : a.score <= b.score);
      }
    }
  }
  const active = candidates.filter((r) => r.is_active && !r.manually_deleted && r.search_state === 'match');
  const report = {
    evaluatedAt: new Date().toISOString(),
    assessments: rows.length,
    zeroBefore: rows.filter((r) => JSON.parse(r.result).score === 0).length,
    zeroAfter: candidates.filter((r) => r.fitSummary.score === 0).length,
    activeMatches: active.length,
    activeZerosAfter: active.filter((r) => r.fitSummary.score === 0).length,
    distinctScoresAfter: new Set(candidates.map((r) => r.fitSummary.score)).size,
    distinctFailedScoresAfter: new Set(
      candidates.filter((r) => r.fitSummary.hardFailure).map((r) => r.fitSummary.score),
    ).size,
    preservedVerdictsEvidenceAndDates: true,
    rankingChecksPassed: true,
    paidModelCalls: 0,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
