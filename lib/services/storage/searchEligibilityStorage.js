/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { searchEligibility } from '../listings/searchEligibility.js';

/**
 * Recheck stored evidence against the current job atomically. User deletions and annotations
 * remain untouched. The optional database is the migration/maintenance connection.
 * @param {string|null} jobId Null rechecks every job.
 * @param {string|null} listingId Optional listing primary key.
 * @param {import('better-sqlite3').Database|null} [db=null]
 * @returns {{match:number, review:number, excluded:number}}
 */
export function recheckSearchEligibility(jobId = null, listingId = null, db = null) {
  const query = (sql, params) => (db ? db.prepare(sql).all(params) : SqliteConnection.query(sql, params));
  const execute = (sql, params) => (db ? db.prepare(sql).run(params) : SqliteConnection.execute(sql, params));
  const run = () => {
    const counts = { match: 0, review: 0, excluded: 0 };
    const jobs = query('SELECT id, provider, spatial_filter FROM jobs WHERE (@jobId IS NULL OR id = @jobId)', {
      jobId,
    });
    for (const job of jobs) {
      const rows = query(
        `SELECT id, title, description, latitude, longitude, location_source FROM listings
        WHERE job_id = @jobId AND (@listingId IS NULL OR id = @listingId)`,
        { jobId: job.id, listingId },
      );
      for (const row of rows) {
        const result = searchEligibility(row, job);
        execute('UPDATE listings SET search_state = @state, search_reason = @reason WHERE id = @id', {
          ...result,
          id: row.id,
        });
        counts[result.state]++;
      }
    }
    return counts;
  };
  return db ? db.transaction(run)() : SqliteConnection.withTransaction(run);
}

/** Recheck before delivery, so stale in-flight runs cannot notify against an older boundary. */
export function matchingSearchListings(listings, jobId) {
  if (!listings.length) return [];
  recheckSearchEligibility(jobId);
  const ids = new Set(
    SqliteConnection.query(
      `SELECT id FROM listings
    WHERE job_id = @jobId AND search_state = 'match' AND manually_deleted = 0`,
      { jobId },
    ).map((row) => row.id),
  );
  return listings.filter((listing) => ids.has(listing.id));
}
