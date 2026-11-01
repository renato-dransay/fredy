/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ active: true, due: [], mailboxes: [] }));
vi.mock('../../lib/services/deploymentGate.js', () => ({ isDeploymentActive: () => state.active }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: { execute: vi.fn(), query: vi.fn() },
}));
vi.mock('../../lib/services/applications/mail.js', () => ({ sendApplication: vi.fn(), syncMailbox: vi.fn() }));
vi.mock('../../lib/services/applications/storage.js', () => ({ addEvent: vi.fn() }));
const { default: db } = await import('../../lib/services/storage/SqliteConnection.js');
const { sendApplication, syncMailbox } = await import('../../lib/services/applications/mail.js');
const { addEvent } = await import('../../lib/services/applications/storage.js');
const { startApplicationScheduler } = await import('../../lib/services/applications/scheduler.js');
let stop;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
  vi.clearAllMocks();
  state.active = true;
  state.due = [];
  state.mailboxes = [];
  db.query.mockImplementation((sql) =>
    sql.includes('auto_send_at<=')
      ? state.due
      : sql.includes('FROM application_mail')
        ? state.mailboxes
        : [{ id: 'record' }],
  );
  db.execute.mockImplementation((sql) => {
    if (sql.includes('SET auto_send_at=NULL')) state.due = [];
  });
  sendApplication.mockResolvedValue({});
  syncMailbox.mockResolvedValue({ matched: 0, scanned: 0 });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe('automatic application entry point', () => {
  it('waits for activation, dispatches the exact reviewed revision, and stops cleanly', async () => {
    state.active = false;
    state.due = [{ id: 'record', user_id: 'alice', listing_id: 'flat', revision: 7 }];
    state.mailboxes = [{ user_id: 'alice' }];
    stop = startApplicationScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendApplication).not.toHaveBeenCalled();
    state.active = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(sendApplication).toHaveBeenCalledWith('alice', 'flat', 'scheduled:record:7', {
      expectedRevision: 7,
      scheduled: true,
    });
    expect(syncMailbox).toHaveBeenCalledWith('alice');
    stop();
    await vi.advanceTimersByTimeAsync(600000);
    expect(sendApplication).toHaveBeenCalledTimes(1);
  });
  it('does not overlap a slow dispatch with the next timer tick', async () => {
    let release;
    sendApplication.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    state.due = [{ id: 'record', user_id: 'alice', listing_id: 'flat', revision: 2 }];
    stop = startApplicationScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sendApplication).toHaveBeenCalledTimes(1);
    release({});
    await vi.advanceTimersByTimeAsync(0);
  });
  it('records failed scheduled delivery and clears only that reviewed schedule', async () => {
    state.due = [{ id: 'record', user_id: 'alice', listing_id: 'flat', revision: 3 }];
    sendApplication.mockRejectedValue(new Error('controlled missing setup'));
    stop = startApplicationScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(sendApplication).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledWith(
      'UPDATE application_records SET auto_send_at=NULL WHERE id=? AND revision=?',
      ['record', 3],
    );
    expect(addEvent).toHaveBeenCalledWith('record', 'updated', expect.stringContaining('not sent'), 'scheduler');
  });
  it('checks configured inboxes on the five-minute cadence', async () => {
    state.mailboxes = [{ user_id: 'alice' }];
    stop = startApplicationScheduler();
    await vi.advanceTimersByTimeAsync(240000);
    expect(syncMailbox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncMailbox).toHaveBeenCalledTimes(2);
  });
});
