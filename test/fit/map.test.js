/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
const ctx = vi.hoisted(() => ({ db: null }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = {}) => ctx.db.prepare(sql).all(params),
    execute: (sql, params = {}) => ctx.db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: () => false }));
import { up } from '../../lib/services/storage/migrations/sql/54.apartment-fit.js';
import { up as addInstructions } from '../../lib/services/storage/migrations/sql/57.fit-instructions.js';
import { saveFitProfile, saveFitResult } from '../../lib/services/fit/storage.js';
import { fitEvidenceHash } from '../../lib/services/fit/evaluate.js';
import listingsPlugin from '../../lib/api/routes/listingsRouter.js';
let app;
const listing = {
  id: 'one',
  title: 'Flat',
  description: 'Source description',
  price: 1500,
  size: 90,
  rooms: 3,
  latitude: 52.52,
  longitude: 13.4,
  address: 'Berlin',
  link: 'https://example.com/one',
  provider: 'immoscout',
  charges: 150,
  charges_included: 0,
  energy_class: 'B',
};

beforeEach(async () => {
  ctx.db = new Database(':memory:');
  ctx.db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, user_id TEXT, shared_with_user TEXT, name TEXT, deal_type TEXT);
    CREATE TABLE listings(id TEXT PRIMARY KEY,job_id TEXT,title TEXT,description TEXT,price REAL,size REAL,rooms REAL,
      address TEXT,link TEXT,provider TEXT,latitude REAL,longitude REAL,image_url TEXT,charges REAL,charges_included INTEGER,
      energy_class TEXT,is_active INTEGER DEFAULT 1,manually_deleted INTEGER DEFAULT 0);
    CREATE TABLE listing_travel_times(listing_id TEXT);
    INSERT INTO users VALUES('alice'),('bob');
    INSERT INTO jobs VALUES('mine','alice','[]','My search','rent'),('private','bob','[]','Private','rent');`);
  const fields = Object.keys(listing);
  ctx.db
    .prepare(
      `INSERT INTO listings(${fields.join(',')}, job_id) VALUES(${fields.map((field) => '@' + field).join(',')},'mine')`,
    )
    .run(listing);
  ctx.db.exec(
    "INSERT INTO listings(id,job_id,title,latitude,longitude) VALUES('hidden','private','Private flat',52.52,13.4)",
  );
  up(ctx.db);
  addInstructions(ctx.db);
  const profile = saveFitProfile('alice', { document: 'Private preferences', criteria: [] });
  saveFitResult('alice', listing.id, {
    score: 90,
    coverage: 100,
    criteria: [],
    evidenceHash: fitEvidenceHash(profile, listing),
    evaluatedAt: new Date().toISOString(),
  });
  saveFitResult('bob', listing.id, {
    score: 20,
    coverage: 100,
    criteria: [],
    evidenceHash: 'other-user',
    evaluatedAt: new Date().toISOString(),
  });
  app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: 'alice' };
  });
  await app.register(listingsPlugin, { prefix: '/api/listings' });
});
afterEach(async () => {
  await app?.close();
  ctx.db.close();
});

describe('map API with real SQLite listing projection and saved fit', () => {
  it('uses complete evidence for fresh fit, keeps user scope and omits source-only fields', async () => {
    const response = await app.inject('/api/listings/map?userId=bob');
    expect(response.statusCode).toBe(200);
    const rows = response.json().listings;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'one', fitSummary: { score: 90, stale: false } });
    for (const field of ['description', 'charges', 'charges_included', 'energy_class'])
      expect(rows[0]).not.toHaveProperty(field);
    expect(JSON.stringify(rows)).not.toContain('Private preferences');
  });
  it('detects changed source evidence and preserves job filtering', async () => {
    ctx.db.exec("UPDATE listings SET description='Changed advert' WHERE id='one'");
    expect((await app.inject('/api/listings/map?jobId=mine')).json().listings[0].fitSummary.stale).toBe(true);
    expect((await app.inject('/api/listings/map?jobId=private')).json().listings).toEqual([]);
  });
});
