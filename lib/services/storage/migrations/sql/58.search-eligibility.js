/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { recheckSearchEligibility } from '../../searchEligibilityStorage.js';

/** Keep automatic search decisions separate from user deletions; legacy positions need review. */
export function up(db) {
  db.exec(`ALTER TABLE listings ADD COLUMN location_source TEXT;
    ALTER TABLE listings ADD COLUMN search_state TEXT NOT NULL DEFAULT 'match';
    ALTER TABLE listings ADD COLUMN search_reason TEXT;
    CREATE INDEX idx_listings_search_state ON listings(job_id, search_state, manually_deleted);`);
  recheckSearchEligibility(null, null, db);
}
