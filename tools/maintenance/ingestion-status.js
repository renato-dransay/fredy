/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Read-only ingestion health report. Run inside Fredy's container, or pass --db /absolute/file.db.
 * Exit 1 means failed, interrupted, overdue or missing runs; exit 2 means the report is unavailable.
 * No credentials, provider URLs, mutations, schema initialization or restart recovery are involved.
 */
import Database from 'better-sqlite3';
import { ingestionStatus } from '../../lib/services/ingestion/statusReport.js';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--db')) {
  process.stderr.write('Usage: node tools/maintenance/ingestion-status.js [--db /path/listings.db]\n');
  process.exitCode = 2;
} else {
  let db;
  try {
    db = new Database(args[1] ?? '/db/listings.db', { readonly: true, fileMustExist: true });
    const report = ingestionStatus(db);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.providers.some(({ health }) => ['failed', 'interrupted', 'overdue', 'no_history'].includes(health)))
      process.exitCode = 1;
  } catch {
    process.stderr.write('Ingestion monitoring is unavailable; check the database path and migration 61.\n');
    process.exitCode = 2;
  } finally {
    db?.close();
  }
}
