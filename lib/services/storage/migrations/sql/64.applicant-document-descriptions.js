/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Add private explanatory notes without rewriting uploaded bytes or document receipts. */
export function up(db) {
  db.exec("ALTER TABLE applicant_documents ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}
