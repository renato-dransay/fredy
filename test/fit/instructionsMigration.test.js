/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../lib/services/storage/migrations/sql/54.apartment-fit.js';
import { up as migrate } from '../../lib/services/storage/migrations/sql/57.fit-instructions.js';

describe('private fit instruction migration', () => {
  it('preserves existing documents, criteria, versions and receipts while defaulting guidance', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE listings(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'); INSERT INTO listings VALUES('flat');",
      );
      up(db);
      db.exec(`INSERT INTO apartment_fit_profiles VALUES('alice','Private document','[]',3,'before');
        INSERT INTO apartment_fit_results VALUES('alice','flat','hash','{"score":70}','before');`);
      const old = db.prepare('SELECT * FROM apartment_fit_profiles').get();
      const receipts = db.prepare('SELECT * FROM apartment_fit_results').all();
      db.transaction(() => migrate(db))();
      expect(db.prepare('SELECT * FROM apartment_fit_profiles').get()).toEqual({ ...old, instructions: '' });
      expect(db.prepare('SELECT * FROM apartment_fit_results').all()).toEqual(receipts);
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
});
