/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
let db;
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    getConnection: () => db,
    query: (sql, params = {}) => db.prepare(sql).all(params),
    execute: (sql, params = {}) => db.prepare(sql).run(params),
    withTransaction: (fn) => db.transaction(() => fn(db))(),
  },
}));
vi.mock('../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));
import { searchEligibility, isSwapOffer } from '../../lib/services/listings/searchEligibility.js';
import {
  recheckSearchEligibility,
  matchingSearchListings,
} from '../../lib/services/storage/searchEligibilityStorage.js';
import { up } from '../../lib/services/storage/migrations/sql/58.search-eligibility.js';
import {
  queryListings,
  getListingsForMap,
  setListingAddress,
  updateListingDetails,
  getGeocoordinatesByAddress,
} from '../../lib/services/storage/listingsStorage.js';
const area = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 50],
            [11, 50],
            [11, 51],
            [10, 51],
            [10, 50],
          ],
        ],
      },
    },
  ],
};
const job = {
  provider: [{ url: 'https://www.immobilienscout24.de/Suche/shape/wohnung-mieten?exclusioncriteria=swapflat' }],
  spatial_filter: area,
};
const known = { title: 'Apartment', latitude: 50.5, longitude: 10.5, location_source: 'portal' };
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,shared_with_user TEXT DEFAULT '[]',deal_type TEXT,provider TEXT,spatial_filter TEXT);
 CREATE TABLE listings(id TEXT PRIMARY KEY,job_id TEXT,title TEXT,description TEXT,provider TEXT,price REAL,size REAL,rooms REAL,address TEXT,link TEXT,image_url TEXT,status TEXT,notes TEXT,distances TEXT,created_at INTEGER,published_at INTEGER,is_active INTEGER DEFAULT 1,manually_deleted INTEGER DEFAULT 0,latitude REAL,longitude REAL,charges REAL,charges_included INTEGER,energy_class TEXT,address_is_manual INTEGER,travel_times_at INTEGER,travel_times_failures INTEGER);
 CREATE TABLE watch_list(id TEXT,listing_id TEXT,user_id TEXT);
 CREATE TABLE listing_attachments(id TEXT,listing_id TEXT);
 CREATE TABLE listing_travel_times(listing_id TEXT,target_id TEXT,label TEXT,address TEXT,lat REAL,lng REAL,transit_minutes REAL,transit_fallback INTEGER,transit_error TEXT,car_minutes REAL,car_error TEXT,bike_minutes REAL,bike_error TEXT,walk_minutes REAL,walk_error TEXT,computed_at INTEGER);`);
  db.prepare('INSERT INTO jobs(id,user_id,name,provider,spatial_filter) VALUES(?,?,?,?,?)').run(
    'job',
    'alice',
    'Search',
    JSON.stringify(job.provider),
    JSON.stringify(area),
  );
  db.prepare('INSERT INTO jobs(id,user_id,name,provider) VALUES(?,?,?,?)').run('private', 'bob', 'Private', '[]');
  db.exec(
    "INSERT INTO listings(id,job_id,title,description,address,latitude,longitude,notes) VALUES('legacy','job','Apartment','','District',50.5,10.5,'keep');",
  );
  up(db);
});
afterEach(() => db.close());
const add = (id, provider = 'immoscout', longitude = 10.5, source = 'portal', title = 'Apartment') =>
  db
    .prepare(
      'INSERT INTO listings(id,job_id,provider,title,address,latitude,longitude,location_source) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(id, 'job', provider, title, 'Street 1', 50.5, longitude, source);
const ids = (page) => page.result.map((row) => row.id).sort();
describe('strict saved area', () => {
  it('applies to every source and separates uncertain evidence', () => {
    for (const provider of ['immoscout', 'kleinanzeigen', 'immowelt', 'ohneMakler']) {
      expect(searchEligibility({ ...known, provider }, job).state).toBe('match');
      expect(searchEligibility({ ...known, provider, longitude: 12 }, job).reason).toBe('outside_area');
    }
    for (const source of [null, 'approximate'])
      expect(searchEligibility({ ...known, location_source: source }, job).state).toBe('review');
    for (const point of [
      { latitude: -1, longitude: -1 },
      { latitude: NaN, longitude: 10 },
      { latitude: 91, longitude: 10 },
    ])
      expect(searchEligibility({ ...known, ...point }, job).state).toBe('review');
    expect(searchEligibility({ ...known, longitude: 10 }, job).state).toBe('match');
    expect(searchEligibility(known, { provider: [], spatial_filter: null }).state).toBe('match');
  });
  it('excludes known swaps before location review without excluding a no-swap statement', () => {
    for (const title of ['Tauschwohnung: Große Wohnung', 'Wohnungstausch', 'Apartment swap'])
      expect(searchEligibility({ title }, job).reason).toBe('swap');
    expect(isSwapOffer({ description: 'Dies ist ein Tauschangebot.' })).toBe(true);
    expect(isSwapOffer({ description: 'Keine Tauschwohnung. Reguläre Vermietung.' })).toBe(false);
  });
  it('migrates conservatively and preserves annotations and manual deletion', () => {
    const row = db.prepare("SELECT * FROM listings WHERE id='legacy'").get();
    expect(row.search_state).toBe('review');
    expect(row.notes).toBe('keep');
    db.exec("UPDATE listings SET manually_deleted=1 WHERE id='legacy'");
    recheckSearchEligibility();
    expect(db.prepare("SELECT manually_deleted FROM listings WHERE id='legacy'").get().manually_deleted).toBe(1);
  });
  it('separates default, review, excluded, map and delivery results with user scoping', () => {
    add('inside');
    add('outside', 'kleinanzeigen', 12);
    add('swap', 'immowelt', 10.5, null, 'Tauschwohnung');
    db.exec("INSERT INTO listings(id,job_id,title) VALUES('private','private','Private')");
    recheckSearchEligibility();
    expect(ids(queryListings({ userId: 'alice' }))).toEqual(['inside']);
    expect(ids(queryListings({ userId: 'alice', searchState: 'review' }))).toEqual(['legacy']);
    expect(ids(queryListings({ userId: 'alice', searchState: 'excluded' }))).toEqual(['outside', 'swap']);
    expect(getListingsForMap({ userId: 'alice' }).listings.map((r) => r.id)).toEqual(['inside']);
    expect(
      matchingSearchListings([{ id: 'inside' }, { id: 'outside' }, { id: 'legacy' }, { id: 'swap' }], 'job'),
    ).toEqual([{ id: 'inside' }]);
  });
  it('rechecks current boundaries and resolves review through the actual address-edit storage path', () => {
    setListingAddress('legacy', 'Confirmed street 1', 50.5, 10.5);
    expect(ids(queryListings({ userId: 'alice' }))).toEqual(['legacy']);
    db.prepare('UPDATE jobs SET spatial_filter=? WHERE id=?').run(
      JSON.stringify({
        ...area,
        features: [
          {
            ...area.features[0],
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [20, 50],
                  [21, 50],
                  [21, 51],
                  [20, 51],
                  [20, 50],
                ],
              ],
            },
          },
        ],
      }),
      'job',
    );
    expect(matchingSearchListings([{ id: 'legacy' }], 'job')).toEqual([]);
    expect(db.prepare("SELECT search_reason,notes FROM listings WHERE id='legacy'").get()).toEqual({
      search_reason: 'outside_area',
      notes: 'keep',
    });
  });
  it('details can exclude a swap immediately; cache retains uncertainty', () => {
    add('inside');
    recheckSearchEligibility();
    updateListingDetails('inside', { description: 'Nur im Tausch. Wohnungstausch.' });
    expect(ids(queryListings({ userId: 'alice' }))).toEqual([]);
    expect(getGeocoordinatesByAddress('District').locationSource).toBeNull();
  });
  it('does not widen malformed areas or crash on malformed features', () => {
    for (const shape of ['{malformed', { features: {} }, { features: [] }, { features: [null] }]) {
      expect(searchEligibility(known, { provider: [], spatial_filter: shape })).toEqual({
        state: 'review',
        reason: 'invalid_area',
      });
    }
    expect(isSwapOffer({ description: 'Wohnungstausch nicht erforderlich.' })).toBe(false);
  });
  it('invalidates location precision and routes when detail text changes the address', () => {
    add('inside');
    recheckSearchEligibility();
    db.exec(
      "UPDATE listings SET distances='old',travel_times_at=100 WHERE id='inside'; INSERT INTO listing_travel_times(listing_id) VALUES('inside');",
    );
    updateListingDetails('inside', { address: 'Faraway Street 20' });
    const row = db
      .prepare("SELECT location_source,search_state,distances,travel_times_at FROM listings WHERE id='inside'")
      .get();
    expect(row).toEqual({
      location_source: 'approximate',
      search_state: 'review',
      distances: null,
      travel_times_at: null,
    });
    expect(db.prepare("SELECT count(*) n FROM listing_travel_times WHERE listing_id='inside'").get().n).toBe(0);
  });
});
