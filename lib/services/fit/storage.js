/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { normalizeProfile } from './profile.js';
import { DEFAULT_JEV_INSTRUCTIONS } from './instructions.js';
import { isFitStale } from './evaluate.js';

/**
 * Attach a compact receipt to rows the caller has already authorized. Always use the acting
 * user's id, including for admins and shared jobs: the listing owner is not the profile owner.
 * One result query per page avoids a request/query per card. Reading never triggers inference.
 * @param {Object[]} listings Authorized listing rows, including the evidence fields.
 * @param {string} userId Acting user.
 * @returns {Object[]} Copies with fitSummary (null means not assessed); no private criteria.
 */
export function attachFitSummaries(listings, userId) {
  if (!listings.length) return [];
  const profile = getFitProfile(userId);
  const rows = SqliteConnection.query(
    `SELECT listing_id, result FROM apartment_fit_results
     WHERE user_id = @userId AND listing_id IN (SELECT value FROM json_each(@ids))`,
    { userId, ids: JSON.stringify(listings.map((listing) => listing.id)) },
  );
  const results = new Map(rows.map((row) => [row.listing_id, JSON.parse(row.result)]));
  return listings.map((listing) => {
    const result = results.get(listing.id);
    return {
      ...listing,
      fitSummary: result
        ? {
            score: result.score,
            coverage: result.coverage,
            hardFailure: result.hardFailure,
            hardUnknown: result.hardUnknown,
            stale: isFitStale(result, profile, listing),
            evaluatedAt: result.evaluatedAt,
            model: result.model,
          }
        : null,
    };
  });
}

/** Return only this user's private preference document. */
export function getFitProfile(userId) {
  const row = SqliteConnection.query(
    'SELECT document, criteria, version, instructions FROM apartment_fit_profiles WHERE user_id = ?',
    [userId],
  )[0];
  return row
    ? {
        document: row.document,
        criteria: JSON.parse(row.criteria),
        version: row.version,
        instructions: row.instructions || DEFAULT_JEV_INSTRUCTIONS,
      }
    : { document: '', criteria: [], version: 0, instructions: DEFAULT_JEV_INSTRUCTIONS };
}

/** Atomically version a profile so in-flight and previously stored assessments become stale. */
export function saveFitProfile(userId, input) {
  const profile = normalizeProfile({
    ...input,
    instructions: input?.instructions ?? getFitProfile(userId).instructions,
  });
  SqliteConnection.execute(
    `INSERT INTO apartment_fit_profiles(user_id,document,criteria,version,updated_at,instructions)
    VALUES (@userId,@document,@criteria,1,@now,@instructions)
    ON CONFLICT(user_id) DO UPDATE SET document=excluded.document, criteria=excluded.criteria,
    version=apartment_fit_profiles.version+1,updated_at=excluded.updated_at,instructions=excluded.instructions`,
    {
      userId,
      document: profile.document,
      instructions: profile.instructions,
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
