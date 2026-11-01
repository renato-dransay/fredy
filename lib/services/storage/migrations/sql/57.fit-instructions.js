/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Keep private evaluator guidance with the versioned profile; existing rows use the default. */
export function up(db) {
  db.exec("ALTER TABLE apartment_fit_profiles ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
}
