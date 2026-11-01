/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
const ctx = vi.hoisted(() => ({ db: null, access: new Set(), listing: null, demo: false }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = []) => ctx.db.prepare(sql).all(params),
    execute: (sql, params = {}) => ctx.db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  userCanAccessListing: (id, userId) => ctx.access.has(`${userId}:${id}`),
  getListingById: (id) => (id === 'one' ? { ...ctx.listing } : null),
}));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({ getSettings: async () => ({ demoMode: ctx.demo }) }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => false }));
vi.mock('../../lib/services/fit/evaluate.js', async (original) => ({ ...(await original()), evaluateFit: vi.fn() }));
import fitPlugin from '../../lib/api/routes/fitRouter.js';
import { up } from '../../lib/services/storage/migrations/sql/54.apartment-fit.js';
import { up as addInstructions } from '../../lib/services/storage/migrations/sql/57.fit-instructions.js';
import { getFitProfile, getFitResult, saveFitProfile, saveFitResult } from '../../lib/services/fit/storage.js';
import { evaluateFit, fitEvidenceHash } from '../../lib/services/fit/evaluate.js';
import { FitProviderError } from '../../lib/services/fit/jev.js';
const criterion = {
  id: 'rooms',
  text: 'At least 3 total rooms',
  kind: 'min_rooms',
  value: 3,
  required: true,
  weight: 1,
};
const profileBody = { document: 'Our private preferences', criteria: [criterion] };
const apps = [];
async function appFor(userId = 'alice') {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: userId };
  });
  await app.register(fitPlugin, { prefix: '/api/fit' });
  await app.ready();
  apps.push(app);
  return app;
}
function resultFor(profile, listing) {
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
  };
}
beforeEach(() => {
  ctx.db = new Database(':memory:');
  ctx.db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE listings(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('alice'),('bob'); INSERT INTO listings VALUES('one');",
  );
  up(ctx.db);
  addInstructions(ctx.db);
  ctx.access = new Set(['alice:one', 'bob:one']);
  ctx.demo = false;
  ctx.listing = { id: 'one', title: 'Flat', rooms: 3, description: 'Three rooms' };
  evaluateFit.mockReset();
  evaluateFit.mockImplementation(async (profile, listing) => resultFor(profile, listing));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  ctx.db.close();
});

describe('fit API private persisted state', () => {
  it('retries expired unknown station evidence while reusing the original semantic receipt', async () => {
    const app = await appFor();
    const profile = saveFitProfile('alice', {
      document: 'Three rooms and close to U2',
      criteria: [
        { ...criterion, id: 'bedrooms', kind: 'semantic', text: 'Two bedrooms' },
        { ...criterion, id: 'metro', kind: 'station_line', line: 'U2', maxWalkMinutes: 10 },
      ],
    });
    const semanticDate = new Date(Date.now() - 120000).toISOString();
    const stored = {
      ...resultFor(profile, ctx.listing),
      evaluatedAt: semanticDate,
      semanticEvaluatedAt: semanticDate,
      model: 'typesafe/jev-1.14-test',
      criteria: profile.criteria.map((criterion) => ({
        ...criterion,
        verdict: criterion.kind === 'station_line' ? 'unknown' : 'met',
        confidence: 0.9,
        evidence: [],
      })),
    };
    saveFitResult('alice', 'one', stored);
    evaluateFit.mockImplementation(async (_profile, _listing, options) => {
      const cached = await options.semantic();
      expect(cached.evaluatedAt).toBe(semanticDate);
      expect(cached.results).toHaveLength(1);
      expect(cached.results[0].id).toBe('bedrooms');
      return { ...stored, evaluatedAt: new Date().toISOString() };
    });
    const response = await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect(response.statusCode).toBe(200);
    expect(evaluateFit).toHaveBeenCalledOnce();
  });
  it('persists/version-controls preferences independently for users sharing a listing', async () => {
    const alice = await appFor();
    const bob = await appFor('bob');
    expect((await alice.inject({ method: 'POST', url: '/api/fit/profile', payload: profileBody })).statusCode).toBe(
      200,
    );
    expect((await alice.inject('/api/fit/profile')).json().profile).toMatchObject({
      document: profileBody.document,
      version: 1,
    });
    expect((await bob.inject('/api/fit/profile')).json().profile).toMatchObject({ document: '', version: 0 });
    await alice.inject({ method: 'POST', url: '/api/fit/profile', payload: profileBody });
    expect(getFitProfile('alice').version).toBe(2);
  });
  it('round-trips private instructions and chip choices, invalidates saved receipts, and preserves guidance for older clients', async () => {
    const alice = await appFor('alice');
    const bob = await appFor('bob');
    const response = await alice.inject({
      method: 'POST',
      url: '/api/fit/profile',
      payload: {
        ...profileBody,
        instructions: 'Require explicit pet permission.',
        criteria: [{ ...criterion, label: 'Rooms', icon: 'rooms' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toMatchObject({
      instructions: 'Require explicit pet permission.',
      criteria: [{ label: 'Rooms', icon: 'rooms' }],
    });
    expect((await bob.inject('/api/fit/profile')).json().profile.instructions).not.toBe(
      'Require explicit pet permission.',
    );
    await alice.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect((await alice.inject('/api/fit/listings/one')).json().stale).toBe(false);
    await alice.inject({
      method: 'POST',
      url: '/api/fit/profile',
      payload: { ...profileBody, instructions: 'Ask for evidence.' },
    });
    expect((await alice.inject('/api/fit/listings/one')).json().stale).toBe(true);
    await alice.inject({ method: 'POST', url: '/api/fit/profile', payload: profileBody });
    expect((await alice.inject('/api/fit/profile')).json().profile.instructions).toBe('Ask for evidence.');
    for (const instructions of [42, 'x'.repeat(4001)]) {
      expect(
        (await alice.inject({ method: 'POST', url: '/api/fit/profile', payload: { ...profileBody, instructions } }))
          .statusCode,
      ).toBe(400);
    }
    await alice.inject({ method: 'POST', url: '/api/fit/profile', payload: { ...profileBody, instructions: '' } });
    expect((await alice.inject('/api/fit/profile')).json().profile.instructions).toContain('Do not equate total rooms');
  });
  it('rejects an assessment completed after instructions changed', async () => {
    const app = await appFor();
    saveFitProfile('alice', profileBody);
    evaluateFit.mockImplementation(async (profile, listing) => {
      saveFitProfile('alice', { ...profileBody, instructions: 'New guidance during inference.' });
      return resultFor(profile, listing);
    });
    const response = await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect(response.statusCode).toBe(409);
    expect(getFitResult('alice', 'one')).toBeNull();
  });
  it('saves results per user and reuses an unchanged valid assessment without paid calls', async () => {
    saveFitProfile('alice', profileBody);
    const alice = await appFor();
    const bob = await appFor('bob');
    const response = await alice.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.score).toBe(100);
    expect(getFitResult('alice', 'one').model).toBe('deterministic-v1');
    expect((await bob.inject('/api/fit/listings/one')).json()).toEqual({ result: null, stale: false });
    await alice.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect(evaluateFit).toHaveBeenCalledTimes(1);
  });
  it('refuses inaccessible or unauthenticated listing reads and mutations', async () => {
    const app = await appFor();
    const anonymous = await appFor(null);
    expect((await app.inject('/api/fit/listings/private')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/fit/listings/private/evaluate' })).statusCode).toBe(404);
    expect((await anonymous.inject('/api/fit/profile')).statusCode).toBe(401);
    expect(evaluateFit).not.toHaveBeenCalled();
  });
  it('requires actual criteria and rejects malformed profile bodies and demo writes', async () => {
    const app = await appFor();
    expect((await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/fit/profile', payload: { criteria: [{}] } })).statusCode,
    ).toBe(400);
    ctx.demo = true;
    expect((await app.inject({ method: 'POST', url: '/api/fit/profile', payload: profileBody })).statusCode).toBe(403);
  });
  it('rechecks listing access after an asynchronous provider call before storing or returning evidence', async () => {
    saveFitProfile('alice', profileBody);
    const app = await appFor();
    evaluateFit.mockImplementation(async (profile, listing) => {
      ctx.access.delete('alice:one');
      return resultFor(profile, listing);
    });
    expect((await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' })).statusCode).toBe(404);
    expect(getFitResult('alice', 'one')).toBeNull();
  });
  it('does not persist a result if the profile or apartment changed during evaluation', async () => {
    saveFitProfile('alice', profileBody);
    const app = await appFor();
    evaluateFit.mockImplementation(async (profile, listing) => {
      saveFitProfile('alice', { ...profileBody, document: 'Changed preferences' });
      return resultFor(profile, listing);
    });
    expect((await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' })).statusCode).toBe(409);
    expect(getFitResult('alice', 'one')).toBeNull();
  });
  it('keeps previous results on missing credentials/provider errors and exposes staleness', async () => {
    const profile = saveFitProfile('alice', profileBody);
    saveFitResult('alice', 'one', resultFor(profile, ctx.listing));
    ctx.listing.description = 'Changed description';
    evaluateFit.mockRejectedValue(new FitProviderError('not_configured'));
    const app = await appFor();
    const response = await app.inject({ method: 'POST', url: '/api/fit/listings/one/evaluate' });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('not_configured');
    expect((await app.inject('/api/fit/listings/one')).json()).toMatchObject({ stale: true, result: { score: 100 } });
  });
  it('reads the stored private profile and cascades deleting its user', () => {
    saveFitProfile('alice', profileBody);
    expect(getFitProfile('alice').document).toBe(profileBody.document);
    ctx.db.prepare('DELETE FROM users WHERE id=?').run('alice');
    expect(getFitProfile('alice').version).toBe(0);
  });
});
