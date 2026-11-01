/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const ctx = vi.hoisted(() => ({ db: null, jobs: new Map(), settings: new Map(), access: new Set(), demo: false }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = []) => ctx.db.prepare(sql).all(params),
    execute: (sql, params = {}) => ctx.db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: (id) => ctx.jobs.get(id),
  getJobs: () => [...ctx.jobs.values()],
}));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ demoMode: ctx.demo }),
  getUserSettings: (id) => ctx.settings.get(id) ?? {},
  upsertSettings: (values, id) => ctx.settings.set(id, { ...ctx.settings.get(id), ...values }),
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  getListingById: (id, userId) =>
    ctx.access.has(`${userId}:${id}`) ? ctx.db.prepare('SELECT * FROM listings WHERE id=?').get(id) : null,
}));
vi.mock('../../lib/services/logger.js', () => ({ default: { warn: vi.fn() } }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => false }));
vi.mock('../../lib/services/fit/evaluate.js', async (original) => ({ ...(await original()), evaluateFit: vi.fn() }));

import {
  assessAutomaticListings,
  automaticFitJobs,
  automaticFitStatus,
  drainAutomaticFit,
  saveAutomaticFitJobs,
} from '../../lib/services/fit/automation.js';
import { evaluateStoredFit } from '../../lib/services/fit/evaluationService.js';
import { evaluateFit, fitEvidenceHash } from '../../lib/services/fit/evaluate.js';
import { getFitProfile, getFitResult, saveFitProfile, saveFitResult } from '../../lib/services/fit/storage.js';
import { FitProviderError } from '../../lib/services/fit/jev.js';
import { getListingById } from '../../lib/services/storage/listingsStorage.js';
import { up } from '../../lib/services/storage/migrations/sql/54.apartment-fit.js';
import fitAutomationPlugin from '../../lib/api/routes/fitAutomationRouter.js';

const apps = [];
const criterion = {
  id: 'size',
  text: 'At least 85 square metres',
  kind: 'min_size',
  value: 85,
  required: true,
  weight: 10,
};
const profileBody = { document: 'Private requirements', criteria: [criterion] };

function receipt(profile, listing, extra = {}) {
  return {
    score: 100,
    coverage: 100,
    hardFailure: false,
    hardUnknown: false,
    criteria: [{ ...criterion, verdict: 'met', confidence: 1, evidence: [] }],
    profileVersion: profile.version,
    evidenceHash: fitEvidenceHash(profile, listing),
    evaluatedAt: new Date().toISOString(),
    model: 'deterministic-v1',
    ...extra,
  };
}

function insertListing(id, extra = {}) {
  const row = {
    id,
    job_id: 'a',
    provider: 'immoscout',
    created_at: Date.now() + 1000,
    is_active: 1,
    manually_deleted: 0,
    title: `Apartment ${id}`,
    description: 'A flat',
    size: 90,
    ...extra,
  };
  ctx.db
    .prepare(`INSERT INTO listings(id,job_id,provider,created_at,is_active,manually_deleted,title,description,size)
    VALUES(@id,@job_id,@provider,@created_at,@is_active,@manually_deleted,@title,@description,@size)`)
    .run(row);
  ctx.access.add(`${ctx.jobs.get(row.job_id)?.userId ?? 'alice'}:${id}`);
  return row;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function appFor(userId = 'alice') {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: userId };
  });
  await app.register(fitAutomationPlugin, { prefix: '/api/fit/automation' });
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(() => {
  ctx.db = new Database(':memory:');
  ctx.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES('alice'),('bob');
    CREATE TABLE listings(id TEXT PRIMARY KEY,job_id TEXT,provider TEXT,created_at INTEGER,
      is_active INTEGER,manually_deleted INTEGER,title TEXT,description TEXT,size REAL);`);
  up(ctx.db);
  ctx.jobs = new Map([
    [
      'a',
      {
        id: 'a',
        name: 'Alice search',
        userId: 'alice',
        enabled: true,
        provider: [{ id: 'immoscout' }, { id: 'disabled', enabled: false }],
      },
    ],
    ['b', { id: 'b', name: 'Bob search', userId: 'bob', enabled: true, provider: [{ id: 'immoscout' }] }],
  ]);
  ctx.settings = new Map();
  ctx.access = new Set();
  ctx.demo = false;
  saveFitProfile('alice', profileBody);
  saveFitProfile('bob', profileBody);
  evaluateFit.mockReset();
  evaluateFit.mockImplementation(async (profile, listing) => receipt(profile, listing));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  ctx.db.close();
});

describe('explicit automatic fit consent and candidate recovery', () => {
  it('requires a per-job opt-in, preserves activation time, and rejects another owner without changing settings', async () => {
    const listing = insertListing('one');
    await assessAutomaticListings('a', [listing]);
    expect(evaluateFit).not.toHaveBeenCalled();
    const [saved] = saveAutomaticFitJobs('alice', ['a', 'a']);
    expect(saved).toMatchObject({ jobId: 'a' });
    expect(saved.since).toBeGreaterThan(0);
    expect(saveAutomaticFitJobs('alice', ['a'])).toEqual([saved]);
    expect(() => saveAutomaticFitJobs('alice', ['a', 'b'])).toThrow();
    expect(automaticFitJobs('alice')).toEqual([saved]);
    expect(automaticFitJobs('bob')).toEqual([]);
  });

  it('limits each pending batch to twenty and resumes later without assessing history, hidden rows, or disabled sources', async () => {
    const [{ since }] = saveAutomaticFitJobs('alice', ['a']);
    insertListing('history', { created_at: since - 1 });
    insertListing('inactive', { is_active: 0 });
    insertListing('deleted', { manually_deleted: 1 });
    insertListing('disabled', { provider: 'disabled' });
    insertListing('foreign', { job_id: 'b' });
    for (let n = 1; n <= 25; n++) insertListing(`new-${String(n).padStart(2, '0')}`);
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(20);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM apartment_fit_results').get().n).toBe(20);
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(25);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM apartment_fit_results').get().n).toBe(25);
    expect(getFitResult('alice', 'history')).toBeNull();
    expect(getFitResult('alice', 'disabled')).toBeNull();
    expect(getFitResult('bob', 'foreign')).toBeNull();
    expect(ctx.db.prepare('SELECT count(*) AS n FROM listings').get().n).toBe(30);
  });

  it.each(['opt-out', 'disabled-job', 'demo'])('does no provider work after %s', async (mode) => {
    saveAutomaticFitJobs('alice', ['a']);
    const listing = insertListing('one');
    if (mode === 'opt-out') saveAutomaticFitJobs('alice', []);
    if (mode === 'disabled-job') ctx.jobs.get('a').enabled = false;
    if (mode === 'demo') ctx.demo = true;
    await assessAutomaticListings('a', [listing]);
    await drainAutomaticFit('a');
    expect(evaluateFit).not.toHaveBeenCalled();
    expect(getFitResult('alice', 'one')).toBeNull();
  });

  it('keeps old receipts and listing rows on provider outage, persists cooldown, and retries after it expires', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const old = insertListing('already-assessed');
    const previous = receipt(getFitProfile('alice'), old);
    saveFitResult('alice', old.id, previous);
    for (let n = 0; n < 5; n++) insertListing(`new-${n}`);
    evaluateFit.mockRejectedValue(new FitProviderError('provider_unavailable'));
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(4);
    expect(getFitResult('alice', old.id)).toEqual(previous);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM listings').get().n).toBe(6);
    expect(ctx.settings.get('alice').automaticFitCooldowns.a).toBeGreaterThan(Date.now());
    expect(automaticFitStatus('a', 'new-0')).toBe('unavailable');
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(4);
    ctx.settings.get('alice').automaticFitCooldowns.a = Date.now() - 1;
    evaluateFit.mockImplementation(async (profile, listing) => receipt(profile, listing));
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(9);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM apartment_fit_results').get().n).toBe(6);
  });

  it('uses only the owner receipt for generic categories and marks changed evidence pending', () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listing = insertListing('one');
    const profile = getFitProfile('alice');
    saveFitResult('bob', 'one', receipt(getFitProfile('bob'), listing, { hardFailure: true }));
    expect(automaticFitStatus('a', 'one')).toBe('pending');
    for (const [extra, expected] of [
      [{}, 'matched'],
      [{ hardUnknown: true }, 'unknown'],
      [{ hardFailure: true, hardUnknown: true }, 'failed'],
    ]) {
      saveFitResult('alice', 'one', receipt(profile, listing, extra));
      expect(automaticFitStatus('a', 'one')).toBe(expected);
    }
    ctx.db.prepare('UPDATE listings SET size=80 WHERE id=?').run('one');
    expect(automaticFitStatus('a', 'one')).toBe('pending');
    saveAutomaticFitJobs('alice', []);
    expect(automaticFitStatus('a', 'one')).toBeNull();
  });
});

describe('shared manual and automatic evaluation guard', () => {
  it('coalesces concurrent manual and automatic requests and persists one owner result', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listing = insertListing('one');
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const manual = evaluateStoredFit('alice', listing.id, () => getListingById(listing.id, 'alice'));
    const automatic = assessAutomaticListings('a', [listing]);
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([manual, automatic]);
    expect(evaluateFit).toHaveBeenCalledTimes(1);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM apartment_fit_results').get().n).toBe(1);
    expect(getFitResult('bob', listing.id)).toBeNull();
  });

  it('caps combined provider concurrency at four and lets a later drain recover a busy candidate', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listings = Array.from({ length: 5 }, (_, n) => insertListing(`one-${n}`));
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const automatic = assessAutomaticListings('a', listings.slice(0, 4));
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(4));
    await expect(
      evaluateStoredFit('alice', listings[4].id, () => getListingById(listings[4].id, 'alice')),
    ).rejects.toMatchObject({ code: 'busy', statusCode: 429 });
    expect(evaluateFit).toHaveBeenCalledTimes(4);
    gate.resolve();
    await automatic;
    await drainAutomaticFit('a');
    expect(evaluateFit).toHaveBeenCalledTimes(5);
  });

  it.each(['access', 'source', 'profile'])('does not persist an in-flight result after %s changes', async (change) => {
    const listing = insertListing('one');
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const pending = evaluateStoredFit('alice', listing.id, () => getListingById(listing.id, 'alice'));
    const rejected = expect(pending).rejects.toMatchObject({
      code: change === 'access' ? 'not_found' : 'source_changed',
    });
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(1));
    if (change === 'access') ctx.access.delete('alice:one');
    if (change === 'source') ctx.db.prepare('UPDATE listings SET size=80 WHERE id=?').run('one');
    if (change === 'profile') saveFitProfile('alice', { ...profileBody, document: 'Updated requirements' });
    gate.resolve();
    await rejected;
    expect(getFitResult('alice', listing.id)).toBeNull();
  });

  it('does not persist automatic results after the source is disabled during inference', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listing = insertListing('one');
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const pending = assessAutomaticListings('a', [listing]);
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(1));
    ctx.jobs.get('a').provider[0].enabled = false;
    gate.resolve();
    await pending;
    expect(getFitResult('alice', listing.id)).toBeNull();
  });

  it('does not reuse the old consent after opting out and activating a later cutoff during inference', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listing = insertListing('one');
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const pending = assessAutomaticListings('a', [listing]);
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(1));
    saveAutomaticFitJobs('alice', []);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(listing.created_at + 1);
    saveAutomaticFitJobs('alice', ['a']);
    clock.mockRestore();
    gate.resolve();
    await pending;
    expect(getFitResult('alice', listing.id)).toBeNull();
  });

  it('does not start another provider call when demo mode is enabled between automatic chunks', async () => {
    saveAutomaticFitJobs('alice', ['a']);
    const listings = Array.from({ length: 5 }, (_, n) => insertListing(`one-${n}`));
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const pending = assessAutomaticListings('a', listings);
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(4));
    ctx.demo = true;
    gate.resolve();
    await pending;
    expect(evaluateFit).toHaveBeenCalledTimes(4);
    expect(getFitResult('alice', listings[4].id)).toBeNull();
  });

  it('rechecks a coalesced caller access without duplicating or exposing another authorized receipt', async () => {
    const listing = insertListing('one');
    const gate = deferred();
    evaluateFit.mockImplementation(async (profile, value) => {
      await gate.promise;
      return receipt(profile, value);
    });
    const allowed = evaluateStoredFit('alice', listing.id, () => getListingById(listing.id, 'alice'));
    let permitted = true;
    const revoked = evaluateStoredFit('alice', listing.id, () =>
      permitted ? getListingById(listing.id, 'alice') : null,
    );
    const denied = expect(revoked).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
    await vi.waitFor(() => expect(evaluateFit).toHaveBeenCalledTimes(1));
    permitted = false;
    gate.resolve();
    await Promise.all([allowed, denied]);
    expect(evaluateFit).toHaveBeenCalledTimes(1);
    expect(getFitResult('alice', listing.id)).not.toBeNull();
  });
});

describe('automatic fit API ownership and consent', () => {
  it('shows only owned jobs and refuses foreign or malformed selections without changing consent', async () => {
    const app = await appFor();
    expect((await app.inject('/api/fit/automation/')).json()).toEqual({
      jobs: [{ id: 'a', name: 'Alice search' }],
      jobIds: [],
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/fit/automation/', payload: { jobIds: ['a'] } })).json().jobIds,
    ).toEqual(['a']);
    for (const jobIds of [['b'], ['a', 'b'], 'a', Array.from({ length: 101 }, () => 'a')]) {
      const response = await app.inject({ method: 'POST', url: '/api/fit/automation/', payload: { jobIds } });
      expect(response.statusCode).toBe(400);
      expect(automaticFitJobs('alice').map((row) => row.jobId)).toEqual(['a']);
    }
    const bob = await appFor('bob');
    expect((await bob.inject('/api/fit/automation/')).json()).toEqual({
      jobs: [{ id: 'b', name: 'Bob search' }],
      jobIds: [],
    });
  });

  it('refuses anonymous reads/writes and non-admin demo writes', async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject('/api/fit/automation/')).statusCode).toBe(401);
    expect(
      (await anonymous.inject({ method: 'POST', url: '/api/fit/automation/', payload: { jobIds: ['a'] } })).statusCode,
    ).toBe(401);
    const alice = await appFor();
    ctx.demo = true;
    expect(
      (await alice.inject({ method: 'POST', url: '/api/fit/automation/', payload: { jobIds: ['a'] } })).statusCode,
    ).toBe(403);
    expect(automaticFitJobs('alice')).toEqual([]);
    expect(evaluateFit).not.toHaveBeenCalled();
  });
});
