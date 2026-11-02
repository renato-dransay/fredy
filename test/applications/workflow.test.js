/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
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
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ demoMode: state.demo }),
}));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => false }));

const { up } = await import('../../lib/services/storage/migrations/sql/55.application-workflow.js');
const { saveApplication, getApplication, listApplications, recordApplicationEvent, visitCalendar } =
  await import('../../lib/services/applications/storage.js');
const { default: plugin } = await import('../../lib/api/routes/applicationsRouter.js');

beforeEach(() => {
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
});
const draft = {
  recipient: 'landlord@example.org',
  subject: 'Apartment enquiry',
  body: 'I would like to visit this apartment.',
};
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
  it('tracks every lifecycle status without a recipient, letter or mail setup', () => {
    for (const status of [
      'draft',
      'submitted',
      'replied',
      'visit_scheduled',
      'follow_up',
      'rejected',
      'accepted',
      'withdrawn',
    ]) {
      const result = saveApplication('alice', 'flat', { status });
      expect(result.application).toMatchObject({ status, recipient: '', subject: '', body: '' });
      expect(result.application).not.toHaveProperty('sendState');
      expect(result.application).not.toHaveProperty('autoSendAt');
    }
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_mail').get().n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_sends').get().n).toBe(0);
  });
  it('rejects invalid statuses and timezone-free dates without changing the record', () => {
    saveApplication('alice', 'flat', { status: 'submitted' });
    expect(() => saveApplication('alice', 'flat', { status: 'sent' })).toThrow('status');
    expect(() => saveApplication('alice', 'flat', { visitAt: '2026-11-02T12:00' })).toThrow('timezone');
    expect(getApplication('alice', 'flat').application.status).toBe('submitted');
  });
  it('preserves letter drafts and dates when updating only the status', () => {
    saveApplication('alice', 'flat', { ...draft, visitAt: '2026-11-02T12:00:00Z', followUpAt: '2026-11-03T12:00:00Z' });
    const result = saveApplication('alice', 'flat', { status: 'visit_scheduled' });
    expect(result.application).toMatchObject({
      ...draft,
      status: 'visit_scheduled',
      visitAt: '2026-11-02T12:00:00.000Z',
      followUpAt: '2026-11-03T12:00:00.000Z',
    });
    expect(saveApplication('alice', 'flat', { visitAt: null, followUpAt: null }).application).toMatchObject({
      visitAt: null,
      followUpAt: null,
    });
  });
  it('keeps legacy pending and uncertain deliveries editable without reading credentials or losing history', () => {
    const { application } = saveApplication('alice', 'flat', draft);
    state.db
      .prepare('INSERT INTO application_mail(user_id,ciphertext) VALUES (?,?)')
      .run('alice', 'invalid legacy credentials');
    state.db
      .prepare('UPDATE application_records SET auto_send_at=? WHERE id=?')
      .run('2026-11-01T10:00:00Z', application.id);
    state.db
      .prepare('INSERT INTO application_sends VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        'receipt',
        'alice',
        application.id,
        1,
        'legacy-key',
        '<legacy@example.org>',
        'uncertain',
        '2026-11-01',
        '2026-11-01',
      );
    for (const stateName of ['uncertain', 'dispatching']) {
      state.db.prepare('UPDATE application_sends SET state=?').run(stateName);
      expect(saveApplication('alice', 'flat', { status: 'withdrawn' }).application.status).toBe('withdrawn');
    }
    expect(state.db.prepare('SELECT auto_send_at FROM application_records').get().auto_send_at).toBeNull();
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_sends').get().n).toBe(1);
    expect(getApplication('alice', 'flat').events.length).toBeGreaterThan(1);
  });
  it('rejects old scheduling requests without creating an application', () => {
    expect(() => saveApplication('alice', 'flat', { autoSendAt: '2026-11-02T12:00:00Z' })).toThrow(
      'no longer supported',
    );
    expect(getApplication('alice', 'flat').application).toBeNull();
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
  it('rejects anonymous callers and demo mutations', async () => {
    const anonymous = await server(null);
    expect((await anonymous.inject('/api/applications')).statusCode).toBe(401);
    await anonymous.close();
    const app = await server();
    state.demo = true;
    expect((await app.inject({ method: 'POST', url: '/api/applications/listings/flat', payload: {} })).statusCode).toBe(
      403,
    );
    await app.close();
  });
});

describe('removed email endpoints', () => {
  it('provides no mail setup, sending, scheduling, synchronization or reconciliation API', async () => {
    const app = await server();
    for (const [method, path] of [
      ['GET', 'mail'],
      ['POST', 'mail'],
      ['POST', 'mail/sync'],
      ['POST', 'listings/flat/send'],
      ['POST', 'listings/flat/resolve-delivery'],
    ]) {
      const result = await app.inject({ method, url: `/api/applications/${path}` });
      expect(result.statusCode).toBe(404);
    }
    const scheduled = await app.inject({
      method: 'POST',
      url: '/api/applications/listings/flat',
      payload: { autoSendAt: '2026-11-02T12:00:00Z' },
    });
    expect(scheduled.statusCode).toBe(400);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM application_sends').get().n).toBe(0);
    await app.close();
  });
});
