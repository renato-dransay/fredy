/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up } from '../../lib/services/storage/migrations/sql/62.known-only-fit.js';
import { summarizeFit } from '../../lib/services/fit/evaluate.js';

describe('known-only fit score migration', () => {
  it('recalculates every user score without changing evidence, coverage, flags or freshness', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE apartment_fit_results (user_id TEXT, listing_id TEXT, evidence_hash TEXT, evaluated_at TEXT, result TEXT)',
      );
      const insert = db.prepare('INSERT INTO apartment_fit_results VALUES (?, ?, ?, ?, ?)');
      const criteriaSets = [
        [
          { verdict: 'met', weight: 4 },
          { verdict: 'unmet', weight: 1 },
          { verdict: 'unknown', weight: 5 },
        ],
        [
          { verdict: 'met', weight: 2 },
          { verdict: 'unknown', weight: 10, required: true },
        ],
        [
          { verdict: 'unmet', weight: 2, required: true },
          { verdict: 'unknown', weight: 10 },
        ],
        [{ verdict: 'unknown', weight: 10, required: true }],
        [],
      ];
      const originals = criteriaSets.map((criteria) => ({
        ...summarizeFit(criteria),
        score: 0,
        criteria,
        evaluatedAt: '2026-11-01T00:00:00Z',
        evidenceHash: 'original',
        profileVersion: 3,
      }));
      originals.forEach((r, index) =>
        insert.run(`user-${index}`, 'same-listing', 'original', 'before', JSON.stringify(r)),
      );
      up(db);
      up(db);
      const rows = db.prepare('SELECT * FROM apartment_fit_results ORDER BY user_id').all();
      expect(rows.map((row) => JSON.parse(row.result))).toEqual(
        originals.map((r) => ({ ...r, score: summarizeFit(r.criteria).score })),
      );
      expect(rows.map((row) => JSON.parse(row.result).score)).toEqual([80, 100, 0, null, null]);
      expect(rows.every((row) => row.evidence_hash === 'original' && row.evaluated_at === 'before')).toBe(true);
      expect(
        db
          .prepare(
            "SELECT user_id FROM apartment_fit_results WHERE CAST(json_extract(result, '$.score') AS REAL) >= 0 ORDER BY user_id",
          )
          .all(),
      ).toEqual([{ user_id: 'user-0' }, { user_id: 'user-1' }, { user_id: 'user-2' }]);
    } finally {
      db.close();
    }
  });
});
