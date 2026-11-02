/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { up } from '../../lib/services/storage/migrations/sql/64.applicant-document-descriptions.js';

it('preserves existing applicant files and identities when adding explanations', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE applicant_documents(id TEXT PRIMARY KEY,filename TEXT,hash TEXT,created_at INTEGER,content BLOB)',
    );
    const bytes = Buffer.from('%PDF-1.4 existing document');
    db.prepare('INSERT INTO applicant_documents VALUES(?,?,?,?,?)').run(
      'saved-file',
      'income.pdf',
      'saved-hash',
      1234,
      bytes,
    );
    const before = db.prepare('SELECT * FROM applicant_documents').get();
    up(db);
    expect(db.prepare('SELECT * FROM applicant_documents').get()).toEqual({ ...before, description: '' });
  } finally {
    db.close();
  }
});
