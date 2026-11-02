/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up } from '../../lib/services/storage/migrations/sql/59.fit-must-have-score.js';

describe('must-have scoring migration', () => {
  it('removes failed listings from positive score filters while preserving evidence and unknowns', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE apartment_fit_results (user_id TEXT, listing_id TEXT, result TEXT)');
      const insert = db.prepare('INSERT INTO apartment_fit_results VALUES (?, ?, ?)');
      const receipt = (required, verdict) => ({
        score: 90,
        hardFailure: required && verdict === 'unmet',
        evaluatedAt: '2026-11-01T00:00:00Z',
        evidenceHash: 'original',
        criteria: [{ id: 'furnishing', required, verdict, evidence: [{ text: 'Furnished' }] }],
      });
      const failed = receipt(true, 'unmet');
      insert.run('alice', 'flat', JSON.stringify(failed));
      insert.run('bob', 'flat', JSON.stringify(receipt(false, 'unmet')));
      insert.run('alice', 'unknown', JSON.stringify(receipt(true, 'unknown')));
      up(db);
      up(db);
      const rows = db.prepare('SELECT user_id, listing_id, result FROM apartment_fit_results').all();
      expect(JSON.parse(rows[0].result)).toEqual({ ...failed, score: 0 });
      expect(JSON.parse(rows[1].result)).toEqual(receipt(false, 'unmet'));
      expect(JSON.parse(rows[2].result)).toEqual(receipt(true, 'unknown'));
      expect(
        db
          .prepare(
            "SELECT listing_id FROM apartment_fit_results WHERE user_id='alice' AND json_extract(result, '$.score') >= 60",
          )
          .all(),
      ).toEqual([{ listing_id: 'unknown' }]);
    } finally {
      db.close();
    }
  });
});
