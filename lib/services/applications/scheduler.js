/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { isDeploymentActive } from '../deploymentGate.js';
import { sendApplication, syncMailbox } from './mail.js';
import { addEvent } from './storage.js';

/** Start bounded per-minute scheduled sends and per-five-minute mailbox sync after deployment activation. */
export function startApplicationScheduler() {
  // A process that exited after issuing SMTP cannot tell whether the server accepted it.
  SqliteConnection.execute("UPDATE application_sends SET state='uncertain',updated_at=? WHERE state='dispatching'", [
    new Date().toISOString(),
  ]);
  let running = false;
  let ticks = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped || running || !isDeploymentActive()) return;
    running = true;
    try {
      const due = SqliteConnection.query(
        'SELECT user_id,listing_id,id,revision FROM application_records WHERE auto_send_at IS NOT NULL AND auto_send_at<=? ORDER BY auto_send_at LIMIT 10',
        [new Date().toISOString()],
      );
      for (const row of due) {
        if (stopped || !isDeploymentActive()) break;
        try {
          await sendApplication(row.user_id, row.listing_id, `scheduled:${row.id}:${row.revision}`, {
            expectedRevision: row.revision,
            scheduled: true,
          });
        } catch {
          // No retries of an already-due scheduled send, including setup/access failures.
          SqliteConnection.execute('UPDATE application_records SET auto_send_at=NULL WHERE id=? AND revision=?', [
            row.id,
            row.revision,
          ]);
          const stillExists = SqliteConnection.query('SELECT id FROM application_records WHERE id=?', [row.id]);
          if (stillExists.length)
            addEvent(
              row.id,
              'updated',
              'Scheduled application was not sent. Check mail setup, source access, and delivery status before scheduling again.',
              'scheduler',
            );
        }
      }
      if (ticks++ % 5 === 0) {
        const users = SqliteConnection.query(
          "SELECT user_id FROM application_mail ORDER BY COALESCE(last_sync_at,'') LIMIT 20",
        );
        for (const { user_id: userId } of users) {
          if (stopped || !isDeploymentActive()) break;
          try {
            await syncMailbox(userId);
          } catch {
            /* Missing setup/failure is visible on that user's mail page. */
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
