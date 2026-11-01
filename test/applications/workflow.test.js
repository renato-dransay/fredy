/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

const state = vi.hoisted(() => ({ db: null, access: new Set(), active: true, demo: false }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = []) => state.db.prepare(sql).all(params),
    execute: (sql, params = []) => state.db.prepare(sql).run(params),
    withTransaction: (callback) => state.db.transaction(() => callback(state.db))(),
  },
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  userCanAccessListing: (id, user) => state.access.has(`${user}:${id}`),
}));
vi.mock('../../lib/services/deploymentGate.js', () => ({ isDeploymentActive: () => state.active }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ demoMode: state.demo }),
}));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => false }));

const { up } = await import('../../lib/services/storage/migrations/sql/55.application-workflow.js');
const { saveApplication, getApplication, listApplications, recordApplicationEvent, visitCalendar, resolveDelivery } =
  await import('../../lib/services/applications/storage.js');
const { saveMailConfig, publicMailConfig, readMailSecrets } = await import('../../lib/services/applications/config.js');
const { sendApplication, matchReply, syncMailbox } = await import('../../lib/services/applications/mail.js');
const { default: plugin } = await import('../../lib/api/routes/applicationsRouter.js');
let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fredy-applications-'));
  process.env.FREDY_MAIL_KEY_FILE = path.join(directory, 'mail.key');
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys=ON');
  state.db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE listings(id TEXT PRIMARY KEY,title TEXT,link TEXT); INSERT INTO users VALUES ('alice'),('bob'); INSERT INTO listings VALUES ('flat','A flat','https://example.org/flat');",
  );
  up(state.db);
  state.access = new Set(['alice:flat', 'bob:flat']);
  state.active = true;
  state.demo = false;
});
afterEach(() => {
  state.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.FREDY_MAIL_KEY_FILE;
});
const draft = {
  recipient: 'landlord@example.org',
  subject: 'Apartment enquiry',
  body: 'I would like to visit this apartment.',
};
const smtp = {
  smtp: {
    host: 'smtp.example.org',
    port: 587,
    secure: false,
    user: 'alice',
    from: 'alice@example.org',
    password: 'test-password',
  },
};
const setup = () => {
  saveApplication('alice', 'flat', draft);
  saveMailConfig('alice', smtp);
};
const accepted = () => ({ sendMail: vi.fn(async () => ({ accepted: ['landlord@example.org'] })), close: vi.fn() });

async function server(user = 'alice') {
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = user ? { currentUser: user } : {};
    done();
  });
  await app.register(plugin, { prefix: '/api/applications' });
  return app;
}

describe('private application workflow', () => {
  it('keeps separate records and correspondence for users sharing a listing', () => {
    saveApplication('alice', 'flat', draft);
    recordApplicationEvent('alice', 'flat', { kind: 'reply', text: 'Visit available Tuesday.' });
    expect(getApplication('bob', 'flat')).toEqual({ application: null, events: [] });
    saveApplication('bob', 'flat', { status: 'withdrawn' });
    expect(getApplication('alice', 'flat').application.status).toBe('replied');
    expect(listApplications('bob')).toHaveLength(1);
    expect(getApplication('bob', 'flat').events.some((event) => event.text.includes('Tuesday'))).toBe(false);
  });
  it('removes revoked source access from reads and prevents modification', () => {
    saveApplication('alice', 'flat', draft);
    state.access.delete('alice:flat');
    expect(listApplications('alice')).toEqual([]);
    expect(() => saveApplication('alice', 'flat', {})).toThrow('access denied');
  });
  it('distinguishes manually recorded submitted status from delivery proof', () => {
    const result = saveApplication('alice', 'flat', { status: 'submitted' });
    expect(result.application.sendState).toBe('not_sent');
    expect(result.events[0].text).toContain('manually');
  });
  it('rejects header and address-list injection and timezone-free dates', () => {
    expect(() => saveApplication('alice', 'flat', { ...draft, recipient: 'a@example.org,b@example.org' })).toThrow();
    expect(() =>
      saveApplication('alice', 'flat', { ...draft, subject: 'Hello\r\nBcc: attacker@example.org' }),
    ).toThrow();
    expect(() => saveApplication('alice', 'flat', { visitAt: '2026-11-02T12:00' })).toThrow('timezone');
  });
  it('cancels pending automatic consent on message edits or replies', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(saveApplication('alice', 'flat', { ...draft, autoSendAt: future }).application.sendState).toBe('queued');
    expect(saveApplication('alice', 'flat', { body: 'Different message' }).application.autoSendAt).toBeNull();
    saveApplication('alice', 'flat', { autoSendAt: future });
    expect(recordApplicationEvent('alice', 'flat', { kind: 'reply', text: 'Hello' }).application.autoSendAt).toBeNull();
  });
  it('escapes calendar properties and emits UTC visit dates', () => {
    state.db.prepare('UPDATE listings SET title=?').run('Flat\r\nATTENDEE:attacker@example.org, test;two');
    saveApplication('alice', 'flat', { visitAt: '2026-11-02T12:00:00+01:00' });
    const calendar = visitCalendar('alice', 'flat');
    expect(calendar).toContain('DTSTART:20261102T110000Z');
    expect(calendar).toContain('Flat\\nATTENDEE:attacker@example.org\\, test\\;two');
    expect(calendar).not.toContain('\r\nATTENDEE:');
  });
});

describe('mail secrets', () => {
  it('encrypts password bytes at rest and never serializes them', () => {
    saveMailConfig('alice', smtp);
    const row = state.db.prepare('SELECT ciphertext FROM application_mail').get();
    expect(row.ciphertext).not.toContain('test-password');
    expect(JSON.stringify(publicMailConfig('alice'))).not.toContain('test-password');
    expect(publicMailConfig('alice').smtp.passwordSet).toBe(true);
    expect(fs.statSync(process.env.FREDY_MAIL_KEY_FILE).mode & 0o077).toBe(0);
    expect(publicMailConfig('bob').smtp.configured).toBe(false);
  });
  it('retains omitted passwords and clears explicit null, with no corrupt-key fallback', () => {
    saveMailConfig('alice', smtp);
    saveMailConfig('alice', { smtp: { host: 'other.example.org' } });
    expect(readMailSecrets('alice').smtp.password).toBe('test-password');
    saveMailConfig('alice', { smtp: { password: null } });
    expect(publicMailConfig('alice').smtp.configured).toBe(false);
    fs.writeFileSync(process.env.FREDY_MAIL_KEY_FILE, 'corrupt');
    expect(() => readMailSecrets('alice')).toThrow('could not be decrypted');
  });
});

describe('durable application delivery', () => {
  it('requires configured mail without reserving an outbox claim', async () => {
    saveApplication('alice', 'flat', draft);
    await expect(sendApplication('alice', 'flat', 'request-123')).rejects.toMatchObject({
      code: 'mail_not_configured',
    });
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_sends').get().n).toBe(0);
  });
  it('records SMTP acceptance then replays an idempotent request without another send', async () => {
    setup();
    const transport = accepted();
    const createTransport = vi.fn(() => transport);
    const result = await sendApplication('alice', 'flat', 'request-123', { createTransport });
    expect(result.application).toMatchObject({ status: 'submitted', sendState: 'sent' });
    await sendApplication('alice', 'flat', 'request-123', { createTransport });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0][0]).toMatchObject({
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      logger: false,
    });
    await expect(sendApplication('alice', 'flat', 'different-key', { createTransport })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('reserves before awaiting SMTP so simultaneous sends cannot duplicate delivery', async () => {
    setup();
    let finish;
    const transport = {
      sendMail: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      close() {},
    };
    const sending = sendApplication('alice', 'flat', 'request-123', { createTransport: () => transport });
    await expect(
      sendApplication('alice', 'flat', 'request-456', { createTransport: () => transport }),
    ).rejects.toMatchObject({ status: 409 });
    expect(() => saveApplication('alice', 'flat', { body: 'Changed' })).toThrow('in progress');
    finish({ accepted: ['landlord@example.org'] });
    await sending;
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain delivery durable and requires explicit mailbox reconciliation before retry', async () => {
    setup();
    const transport = {
      sendMail: vi.fn(async () => {
        throw new Error('secret upstream details');
      }),
      close() {},
    };
    const result = await sendApplication('alice', 'flat', 'request-123', { createTransport: () => transport });
    expect(result.application).toMatchObject({ status: 'draft', sendState: 'uncertain' });
    expect(JSON.stringify(result)).not.toContain('secret upstream');
    await expect(
      sendApplication('alice', 'flat', 'request-456', { createTransport: () => transport }),
    ).rejects.toMatchObject({ status: 409 });
    expect(() => resolveDelivery('alice', 'flat', { outcome: 'not_sent', note: '' })).toThrow();
    resolveDelivery('alice', 'flat', {
      outcome: 'not_sent',
      note: 'Confirmed in the Sent mailbox that the message was not sent.',
    });
    const retry = await sendApplication('alice', 'flat', 'request-789', { createTransport: accepted });
    expect(retry.application.sendState).toBe('sent');
  });
  it('does not mark submitted when SMTP fails to accept the exact recipient', async () => {
    setup();
    const result = await sendApplication('alice', 'flat', 'request-123', {
      createTransport: () => ({ sendMail: async () => ({ accepted: [] }), close() {} }),
    });
    expect(result.application.status).toBe('draft');
    expect(result.application.sendState).toBe('uncertain');
  });
  it('preserves a receipt even if the listing disappears while SMTP is in flight', async () => {
    setup();
    const transport = {
      sendMail: async () => {
        state.db.prepare("DELETE FROM listings WHERE id='flat'").run();
        return { accepted: ['landlord@example.org'] };
      },
      close() {},
    };
    await sendApplication('alice', 'flat', 'request-123', { createTransport: () => transport });
    expect(state.db.prepare('SELECT state FROM application_sends').get().state).toBe('sent');
  });
});

describe('reply matching and IMAP cursor', () => {
  async function outbound() {
    setup();
    await sendApplication('alice', 'flat', 'request-123', { createTransport: accepted });
    return state.db.prepare('SELECT message_id FROM application_sends').get().message_id;
  }
  it('only matches exact references in the current user and deduplicates message IDs', async () => {
    const reference = await outbound();
    const reply = {
      messageId: '<reply@example.org>',
      inReplyTo: reference,
      text: 'Visit on Tuesday',
      subject: 'Re: apartment',
    };
    expect(matchReply('bob', reply)).toBe(false);
    expect(matchReply('alice', { ...reply, inReplyTo: '<unknown@example.org>' })).toBe(false);
    expect(matchReply('alice', reply)).toBe(true);
    expect(matchReply('alice', reply)).toBe(false);
    expect(getApplication('alice', 'flat').application.status).toBe('replied');
    expect(getApplication('bob', 'flat').application).toBeNull();
  });
  it('persists UID validity/cursor, skips oversized MIME, and leaves mailbox read-only', async () => {
    const reference = await outbound();
    saveMailConfig('alice', { imap: { host: 'imap.example.org', port: 993, user: 'alice', password: 'password' } });
    const release = vi.fn();
    const lock = vi.fn(async () => ({ release }));
    const client = {
      mailbox: { uidValidity: 33n, uidNext: 4 },
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      getMailboxLock: lock,
      fetch: async function* () {
        yield { uid: 1, size: 100, source: Buffer.from('message') };
        yield { uid: 2, size: 99999999, source: Buffer.from('large') };
        yield { uid: 3, size: 100, source: Buffer.from('duplicate') };
      },
    };
    const parseMessage = vi.fn(async () => ({
      messageId: '<reply@example.org>',
      inReplyTo: reference,
      text: 'A reply',
    }));
    expect(await syncMailbox('alice', { clientFactory: () => client, parseMessage })).toEqual({
      matched: 1,
      scanned: 3,
    });
    expect(lock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(parseMessage).toHaveBeenCalledTimes(2);
    expect(state.db.prepare("SELECT uid_validity,last_uid FROM application_mail WHERE user_id='alice'").get()).toEqual({
      uid_validity: '33',
      last_uid: 3,
    });
    expect(await syncMailbox('alice', { clientFactory: () => client, parseMessage })).toEqual({
      matched: 0,
      scanned: 0,
    });
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('authenticated application routes', () => {
  it('provides usable create/read/event/calendar endpoints without exposing another user', async () => {
    const app = await server();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/applications/listings/flat',
          payload: { ...draft, visitAt: '2026-11-02T12:00:00Z' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/applications/listings/flat/events',
          payload: { kind: 'reply', text: 'Hello' },
        })
      ).json().application.status,
    ).toBe('replied');
    expect((await app.inject('/api/applications/listings/flat/visit.ics')).headers['content-type']).toContain(
      'text/calendar',
    );
    expect((await app.inject('/api/applications')).json().applications).toHaveLength(1);
    await app.close();
    const bob = await server('bob');
    expect((await bob.inject('/api/applications/listings/flat')).json()).toEqual({ application: null, events: [] });
    await bob.close();
  });
  it('rejects anonymous callers and demo mutations, with explicit missing connection errors', async () => {
    const anonymous = await server(null);
    expect((await anonymous.inject('/api/applications')).statusCode).toBe(401);
    await anonymous.close();
    const app = await server();
    expect((await app.inject({ method: 'POST', url: '/api/applications/mail/sync' })).json().code).toBe(
      'mail_not_configured',
    );
    state.demo = true;
    expect((await app.inject({ method: 'POST', url: '/api/applications/listings/flat', payload: {} })).statusCode).toBe(
      403,
    );
    await app.close();
  });
});

describe('reviewed draft boundaries', () => {
  it('rejects a send if another tab changed the reviewed envelope', async () => {
    setup();
    const reviewed = getApplication('alice', 'flat').application;
    saveApplication('alice', 'flat', { body: 'A later message that was not reviewed.' });
    const createTransport = vi.fn(accepted);
    await expect(
      sendApplication('alice', 'flat', 'request-123', { createTransport, expectedRevision: reviewed.revision }),
    ).rejects.toMatchObject({ code: 'draft_changed' });
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('never sends a cancelled or rescheduled queued snapshot', async () => {
    setup();
    const scheduled = saveApplication('alice', 'flat', {
      autoSendAt: new Date(Date.now() + 60000).toISOString(),
    }).application;
    saveApplication('alice', 'flat', { autoSendAt: null });
    await expect(
      sendApplication('alice', 'flat', 'request-123', {
        createTransport: accepted,
        expectedRevision: scheduled.revision,
        scheduled: true,
      }),
    ).rejects.toMatchObject({ code: 'schedule_changed' });
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_sends').get().n).toBe(0);
  });
  it('stops old mailbox synchronization after its connection configuration changes', async () => {
    setup();
    saveMailConfig('alice', { imap: { host: 'imap.example.org', port: 993, user: 'alice', password: 'password' } });
    const client = {
      mailbox: { uidValidity: 33n, uidNext: 2 },
      connect: async () => {},
      logout: async () => {},
      getMailboxLock: async () => ({ release() {} }),
      fetch: async function* () {
        saveMailConfig('alice', { imap: { user: 'replacement' } });
        yield { uid: 1, size: 1, source: Buffer.from('a') };
      },
    };
    await expect(syncMailbox('alice', { clientFactory: () => client, parseMessage: vi.fn() })).rejects.toMatchObject({
      code: 'mail_sync_failed',
    });
    expect(state.db.prepare("SELECT uid_validity,last_uid FROM application_mail WHERE user_id='alice'").get()).toEqual({
      uid_validity: null,
      last_uid: 0,
    });
  });
});
