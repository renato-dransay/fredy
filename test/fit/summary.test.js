/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
const ctx = vi.hoisted(() => ({ db: null, userId: 'alice', rows: [] }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: vi.fn((sql, params = []) => ctx.db.prepare(sql).all(params)),
    execute: (sql, params = {}) => ctx.db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  queryListings: () => ({ result: ctx.rows, totalNumber: ctx.rows.length, page: 1 }),
  getAvailableProviders: () => [],
  getListingsForMap: () => ({ listings: ctx.rows }),
  getListingById: (id) => ctx.rows.find((row) => row.id === id) ?? null,
}));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({ getUserSettings: () => ({}) }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => true }));
vi.mock('../../lib/services/storage/listingMediaStorage.js', () => ({ getListingGallery: () => [] }));

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { up } from '../../lib/services/storage/migrations/sql/54.apartment-fit.js';
import { up as addInstructions } from '../../lib/services/storage/migrations/sql/57.fit-instructions.js';
import { attachFitSummaries, saveFitProfile, saveFitResult } from '../../lib/services/fit/storage.js';
import { fitEvidenceHash } from '../../lib/services/fit/evaluate.js';
import listingsPlugin from '../../lib/api/routes/listingsRouter.js';

let profile;
let result;
let app;
const listing = { id: 'one', title: 'Flat', description: 'Private portal source', size: 90, user_id: 'bob' };
const requirement = {
  id: 'size',
  text: 'At least 85 square metres',
  kind: 'min_size',
  value: 85,
  required: true,
  weight: 10,
};

beforeEach(async () => {
  ctx.db = new Database(':memory:');
  ctx.db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE listings(id TEXT PRIMARY KEY);INSERT INTO users VALUES('alice'),('bob');INSERT INTO listings VALUES('one'),('two');",
  );
  up(ctx.db);
  addInstructions(ctx.db);
  ctx.rows = [{ ...listing }, { ...listing, id: 'two' }];
  ctx.userId = 'alice';
  profile = saveFitProfile('alice', { document: 'Private preferences', criteria: [requirement] });
  result = {
    score: 80,
    coverage: 60,
    hardFailure: true,
    hardUnknown: true,
    criteria: [{ ...requirement, verdict: 'unknown', confidence: 0, evidence: [] }],
    profileVersion: profile.version,
    evidenceHash: fitEvidenceHash(profile, listing),
    evaluatedAt: new Date().toISOString(),
    semanticEvaluatedAt: new Date().toISOString(),
    model: 'typesafe/jev-1.14-test',
  };
  saveFitResult('alice', 'one', result);
  saveFitResult('bob', 'one', { ...result, score: 99, criteria: [{ text: 'Bob private requirement' }] });
  app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: ctx.userId };
  });
  await app.register(listingsPlugin, { prefix: '/api/listings' });
});
afterEach(async () => {
  await app.close();
  ctx.db.close();
});

describe('private saved fit summaries', () => {
  it('preserves all-unknown null scores through map, table and detail API responses', async () => {
    saveFitResult('alice', 'one', { ...result, score: null, coverage: 0, hardFailure: false, hardUnknown: true });
    const map = (await app.inject('/api/listings/map')).json().listings[0];
    const table = (await app.inject('/api/listings/table')).json().result[0];
    const detail = (await app.inject('/api/listings/one')).json();
    for (const row of [map, table, detail]) {
      expect(row.fitSummary).toMatchObject({ score: null, coverage: 0, hardUnknown: true });
    }
  });
  it('projects only the current user receipt in two queries per page, including null for unassessed rows', () => {
    SqliteConnection.query.mockClear();
    const rows = attachFitSummaries(ctx.rows, 'alice');
    expect(SqliteConnection.query).toHaveBeenCalledTimes(2);
    expect(rows[0].fitSummary).toEqual({
      score: 80,
      coverage: 60,
      hardFailure: true,
      hardUnknown: true,
      stale: false,
      evaluatedAt: result.evaluatedAt,
      model: result.model,
    });
    expect(rows[1].fitSummary).toBeNull();
    expect(rows[0].fitSummary).not.toHaveProperty('criteria');
    expect(rows[0].fitSummary).not.toHaveProperty('document');
    expect(ctx.rows[0]).not.toHaveProperty('fitSummary');
  });
  it('does no database work for an empty authorized page', () => {
    SqliteConnection.query.mockClear();
    expect(attachFitSummaries([], 'alice')).toEqual([]);
    expect(SqliteConnection.query).not.toHaveBeenCalled();
  });
  it('does not invent an assessment for users who have none', () => {
    ctx.db.prepare("DELETE FROM apartment_fit_results WHERE user_id='alice'").run();
    expect(attachFitSummaries(ctx.rows, 'alice').every((r) => r.fitSummary === null)).toBe(true);
  });
  it('marks changed listing evidence and changed preferences stale, but not personal notes', () => {
    expect(attachFitSummaries([{ ...listing, notes: 'New note' }], 'alice')[0].fitSummary.stale).toBe(false);
    expect(attachFitSummaries([{ ...listing, size: 100 }], 'alice')[0].fitSummary.stale).toBe(true);
    saveFitProfile('alice', { document: 'Changed', criteria: [requirement] });
    expect(attachFitSummaries([listing], 'alice')[0].fitSummary.stale).toBe(true);
  });
  it('uses the existing semantic and unknown-station freshness limits', () => {
    const old = new Date(Date.now() - 86400001).toISOString();
    saveFitResult('alice', 'one', { ...result, semanticEvaluatedAt: old });
    expect(attachFitSummaries([listing], 'alice')[0].fitSummary.stale).toBe(true);
    saveFitResult('alice', 'one', {
      ...result,
      evaluatedAt: new Date(Date.now() - 61000).toISOString(),
      criteria: [{ ...requirement, kind: 'station_line', verdict: 'unknown' }],
    });
    expect(attachFitSummaries([listing], 'alice')[0].fitSummary.stale).toBe(true);
  });
  it('returns fresh current-user map summaries without private evidence or preference text', async () => {
    const response = await app.inject('/api/listings/map?userId=bob');
    expect(response.statusCode).toBe(200);
    const rows = response.json().listings;
    expect(rows[0].fitSummary).toMatchObject({ score: 80, stale: false });
    expect(rows[1].fitSummary).toBeNull();
    expect(rows[0]).not.toHaveProperty('description');
    expect(JSON.stringify(rows)).not.toContain('Private portal source');
    expect(JSON.stringify(rows)).not.toContain('Private preferences');
    expect(JSON.stringify(rows)).not.toContain('Bob private requirement');
  });
  it.each(['description', 'charges', 'charges_included', 'energy_class'])(
    'marks changed %s evidence stale on the map',
    async (field) => {
      ctx.rows[0][field] = field === 'charges' ? 100 : field === 'charges_included' ? true : 'changed';
      const rows = (await app.inject('/api/listings/map')).json().listings;
      expect(rows[0].fitSummary.stale).toBe(true);
      expect(rows[0]).not.toHaveProperty(field);
    },
  );
  it('returns the same private summary from table and detail routes, ignoring a forged user id even for admins', async () => {
    const table = await app.inject({ method: 'GET', url: '/api/listings/table?userId=bob' });
    expect(table.statusCode).toBe(200);
    const rows = table.json().result;
    expect(rows[0].fitSummary.score).toBe(80);
    expect(rows[1].fitSummary).toBeNull();
    const detail = await app.inject({ method: 'GET', url: '/api/listings/one?userId=bob' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().fitSummary).toEqual(rows[0].fitSummary);
    expect(JSON.stringify(rows)).not.toContain('Bob private requirement');
    expect(JSON.stringify(rows)).not.toContain('Private preferences');
    expect((await app.inject({ method: 'GET', url: '/api/listings/inaccessible' })).statusCode).toBe(404);
  });
});
