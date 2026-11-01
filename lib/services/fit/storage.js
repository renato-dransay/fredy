/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { normalizeProfile } from './profile.js';

/** Return only this user's private preference document. */
export function getFitProfile(userId) {
  const row = SqliteConnection.query(
    'SELECT document, criteria, version FROM apartment_fit_profiles WHERE user_id = ?',
    [userId],
  )[0];
  return row
    ? { document: row.document, criteria: JSON.parse(row.criteria), version: row.version }
    : { document: '', criteria: [], version: 0 };
}

/** Atomically version a profile so in-flight and previously stored assessments become stale. */
export function saveFitProfile(userId, input) {
  const profile = normalizeProfile(input);
  SqliteConnection.execute(
    `INSERT INTO apartment_fit_profiles(user_id,document,criteria,version,updated_at)
    VALUES (@userId,@document,@criteria,1,@now)
    ON CONFLICT(user_id) DO UPDATE SET document=excluded.document, criteria=excluded.criteria,
    version=apartment_fit_profiles.version+1,updated_at=excluded.updated_at`,
    {
      userId,
      document: profile.document,
      criteria: JSON.stringify(profile.criteria),
      now: new Date().toISOString(),
    },
  );
  return getFitProfile(userId);
}

/** Read a user's saved result without ever consulting another user's result. */
export function getFitResult(userId, listingId) {
  const row = SqliteConnection.query('SELECT result FROM apartment_fit_results WHERE user_id = ? AND listing_id = ?', [
    userId,
    listingId,
  ])[0];
  return row ? JSON.parse(row.result) : null;
}

/** Persist a complete evaluation only; provider failures never replace useful previous evidence. */
export function saveFitResult(userId, listingId, result) {
  SqliteConnection.execute(
    `INSERT INTO apartment_fit_results(user_id,listing_id,evidence_hash,result,evaluated_at)
    VALUES (@userId,@listingId,@hash,@result,@now)
    ON CONFLICT(user_id,listing_id) DO UPDATE SET evidence_hash=excluded.evidence_hash,
    result=excluded.result,evaluated_at=excluded.evaluated_at`,
    {
      userId,
      listingId,
      hash: result.evidenceHash,
      result: JSON.stringify(result),
      now: result.evaluatedAt,
    },
  );
}
