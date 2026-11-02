/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up } from '../../lib/services/storage/migrations/sql/60.restore-weighted-fit.js';
import { summarizeFit } from '../../lib/services/fit/evaluate.js';

describe('restoring weighted fit scores', () => {
  it('repairs every user receipt without changing verdicts, evidence, flags or freshness', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE apartment_fit_results (user_id TEXT, listing_id TEXT, result TEXT)');
      const insert = db.prepare('INSERT INTO apartment_fit_results VALUES (?, ?, ?)');
      const originals = [
        [
          { required: true, verdict: 'unmet', weight: 10 },
          { required: true, verdict: 'met', weight: 10 },
        ],
        [
          { required: true, verdict: 'unmet', weight: 10 },
          { required: false, verdict: 'met', weight: 2 },
        ],
        [
          { required: true, verdict: 'unknown', weight: 10 },
          { required: false, verdict: 'met', weight: 2 },
        ],
        [{ required: true, verdict: 'unknown', weight: 10 }],
        [],
      ].map((criteria) => ({
        ...summarizeFit(criteria),
        score: 0,
        criteria,
        evaluatedAt: '2026-11-01T00:00:00Z',
        evidenceHash: 'original',
        profileVersion: 3,
      }));
      originals.forEach((r, i) => insert.run(`user-${i}`, 'same-listing', JSON.stringify(r)));
      up(db);
      up(db);
      const rows = db.prepare('SELECT result FROM apartment_fit_results ORDER BY user_id').all();
      expect(rows.map((r) => JSON.parse(r.result))).toEqual(
        originals.map((r, index) => ({ ...r, score: [50, 17, 17, 0, 0][index] })),
      );
      expect(rows.map((r) => JSON.parse(r.result).score)).toEqual([50, 17, 17, 0, 0]);
    } finally {
      db.close();
    }
  });
});
