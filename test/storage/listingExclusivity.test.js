/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { up } from '../../lib/services/storage/migrations/sql/56.listing-exclusivity.js';

let db;
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    getConnection: () => db,
    query: (sql, params = {}) => db.prepare(sql).all(params),
    execute: (sql, params = {}) => db.prepare(sql).run(params),
    withTransaction: (callback) => db.transaction(() => callback(db))(),
  },
}));
vi.mock('../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));

import { storeListings, refreshListingExclusivity } from '../../lib/services/storage/listingsStorage.js';
import Fredy from '../../lib/FredyPipelineExecutioner.js';
import { NoNewListingsWarning } from '../../lib/errors.js';
import { normalizeGetListing } from '../../lib/mcp/mcpNormalizer.js';

const LINK = 'https://www.immobilienscout24.de/expose/123';
const advert = (extra = {}) => ({
  id: 'hash',
  link: LINK,
  title: 'Flat',
  price: 1000,
  size: 80,
  rooms: 3,
  address: 'Berlin',
  image: null,
  description: 'Description',
  ...extra,
});

beforeEach(async () => {
  db = new Database(':memory:');
  const directory = path.resolve('lib/services/storage/migrations/sql');
  for (const file of fs
    .readdirSync(directory)
    .filter((x) => x.endsWith('.js'))
    .sort((a, b) => parseInt(a) - parseInt(b))) {
    const migration = await import(pathToFileURL(path.join(directory, file)).href);
    await (migration.up ?? migration.default)(db);
  }
  db.pragma('foreign_keys = OFF');
});
afterEach(() => db.close());

describe('persisted listing exclusivity', () => {
  it('migration is additive/idempotent and inserts retain the metadata', () => {
    up(db);
    storeListings('job', 'immoscout', [
      advert({ isExclusive: true, exclusiveLabel: 'Suchen+', exclusiveUntil: 1800000000000 }),
    ]);
    expect(db.prepare('select * from listings').get()).toMatchObject({
      is_exclusive: 1,
      exclusive_label: 'Suchen+',
      exclusive_until: 1800000000000,
      description: 'Description',
    });
  });

  it('refreshes known/price-changed adverts by link before novelty short-circuits, preserving annotations and isolation', () => {
    for (const [job, provider] of [
      ['job', 'immoscout'],
      ['other', 'immoscout'],
      ['job', 'other'],
    ]) {
      storeListings(job, provider, [advert({ id: provider === 'other' ? 'other-hash' : 'hash' })]);
    }
    db.prepare('update listings set notes=?,status=?').run('keep', JSON.stringify({ status: 'viewing' }));
    const pipeline = new Fredy({}, { id: 'job' }, 'immoscout', {}, undefined);
    const observed = advert({ isExclusive: true, exclusiveLabel: 'Suchen+', exclusiveUntil: 1800000000000 });
    expect(() => pipeline._findNew([observed])).toThrow(NoNewListingsWarning);
    const rows = db.prepare('select job_id,provider,is_exclusive,notes,status from listings').all();
    expect(rows.filter((x) => x.is_exclusive)).toEqual([
      {
        job_id: 'job',
        provider: 'immoscout',
        is_exclusive: 1,
        notes: 'keep',
        status: JSON.stringify({ status: 'viewing' }),
      },
    ]);
    expect(pipeline._findNew([advert({ ...observed, id: 'new-price-hash', isExclusive: false })])).toHaveLength(1);
    expect(
      db.prepare("select is_exclusive from listings where job_id='job' and provider='immoscout'").get().is_exclusive,
    ).toBe(0);
    expect(db.prepare('select count(*) as n from listings').get().n).toBe(3);
  });

  it('unknown metadata leaves the stored answer alone and invalid expiry is not persisted', () => {
    storeListings('job', 'immoscout', [advert({ isExclusive: true, exclusiveLabel: 'Suchen+', exclusiveUntil: NaN })]);
    refreshListingExclusivity('job', 'immoscout', [advert()]);
    expect(db.prepare('select is_exclusive,exclusive_until from listings').get()).toEqual({
      is_exclusive: 1,
      exclusive_until: null,
    });
    refreshListingExclusivity('job', 'immoscout', [advert({ isExclusive: false })]);
    expect(db.prepare('select is_exclusive,exclusive_label from listings').get()).toEqual({
      is_exclusive: 0,
      exclusive_label: null,
    });
  });

  it('MCP detail reports the badge and expiry and stops claiming expired early access', () => {
    const current = {
      id: '1',
      title: 'Flat',
      is_exclusive: 1,
      exclusive_label: 'Suchen+',
      exclusive_until: Date.now() + 86400000,
    };
    const result = normalizeGetListing(current);
    expect(JSON.stringify(result)).toContain('**Exclusive:** Suchen+');
    expect(JSON.stringify(result)).toContain('**Exclusive until:**');
    expect(JSON.stringify(normalizeGetListing({ ...current, exclusive_until: Date.now() - 1 }))).not.toContain(
      '**Exclusive:**',
    );
  });
});
