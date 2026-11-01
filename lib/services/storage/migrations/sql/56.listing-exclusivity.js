/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Keep the portal's early-access state separately from listing activity and user annotations.
 * Old rows start nonexclusive until a search observes their current state.
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(listings)')
      .all()
      .map((column) => column.name),
  );
  for (const [name, type] of Object.entries({
    is_exclusive: 'INTEGER NOT NULL DEFAULT 0',
    exclusive_label: 'TEXT',
    exclusive_until: 'INTEGER',
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
  }
}
