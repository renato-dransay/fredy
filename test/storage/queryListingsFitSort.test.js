/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
let db;
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = {}) => db.prepare(sql).all(params),
    execute: (sql, params = {}) => db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));
import { queryListings, deleteListingsByFilter } from '../../lib/services/storage/listingsStorage.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,shared_with_user TEXT DEFAULT '[]',deal_type TEXT);
 CREATE TABLE listings( location_source TEXT, search_state TEXT NOT NULL DEFAULT 'match', search_reason TEXT, id TEXT PRIMARY KEY,job_id TEXT,title TEXT,provider TEXT,price REAL,size REAL,rooms REAL,address TEXT,link TEXT,status TEXT,distances TEXT,created_at INTEGER,published_at INTEGER,is_active INTEGER DEFAULT 1,manually_deleted INTEGER DEFAULT 0);
 CREATE TABLE watch_list(id TEXT PRIMARY KEY,listing_id TEXT,user_id TEXT);
 CREATE TABLE listing_attachments(id TEXT PRIMARY KEY,listing_id TEXT);
 CREATE TABLE listing_travel_times(listing_id TEXT,target_id TEXT,label TEXT,address TEXT,lat REAL,lng REAL,transit_minutes REAL,transit_fallback INTEGER,transit_error TEXT,car_minutes REAL,car_error TEXT,bike_minutes REAL,bike_error TEXT,walk_minutes REAL,walk_error TEXT,computed_at INTEGER);
 CREATE TABLE apartment_fit_results(user_id TEXT,listing_id TEXT,result TEXT,PRIMARY KEY(user_id,listing_id));
 INSERT INTO jobs VALUES('owned','alice','Owned','[]','rent'),('shared','bob','Shared','["alice"]','rent'),('private','bob','Private','[]','rent');`);
  const insert = db.prepare('INSERT INTO listings(id,job_id,title,created_at,published_at) VALUES(?,?,?,?,?)');
  for (const [id, job, date] of [
    ['low', 'owned', 900],
    ['high-b', 'owned', 10],
    ['high-a', 'owned', 10],
    ['zero', 'owned', 950],
    ['unassessed', 'owned', 1000],
    ['bob-only', 'shared', 1100],
    ['shared', 'shared', 800],
    ['private', 'private', 1200],
  ])
    insert.run(id, job, id, date, date);
  const score = (user, id, value) =>
    db
      .prepare('INSERT INTO apartment_fit_results VALUES(?,?,?)')
      .run(user, id, JSON.stringify({ score: value, coverage: 50, hardFailure: true }));
  for (const [id, value] of [
    ['high-a', 95],
    ['high-b', 95],
    ['low', 30],
    ['zero', 0],
    ['shared', 70],
    ['private', 99],
  ])
    score('alice', id, value);
  for (const [id, value] of [
    ['high-a', 1],
    ['high-b', 2],
    ['low', 100],
    ['bob-only', 100],
    ['shared', 1],
  ])
    score('bob', id, value);
});
afterEach(() => db.close());
const page = (extra = {}) =>
  queryListings({ userId: 'alice', sortField: 'fit_score', sortDir: 'desc', pageSize: 100, ...extra });
const ids = (result) => result.result.map((row) => row.id);

describe('saved JEV scores sorted in real SQLite', () => {
  it('ranks confirmed must-have failures after other assessed listings without collapsing their scores', () => {
    db.prepare(
      "UPDATE apartment_fit_results SET result=json_set(result, '$.hardFailure', json('false'), '$.hardUnknown', json('true')) WHERE user_id='alice' AND listing_id='low'",
    ).run();
    expect(ids(page())).toEqual(['low', 'high-a', 'high-b', 'shared', 'zero', 'bob-only', 'unassessed']);
    expect(ids(page({ sortDir: 'asc' }))).toEqual([
      'low',
      'zero',
      'shared',
      'high-a',
      'high-b',
      'bob-only',
      'unassessed',
    ]);
    expect(ids(page({ pageSize: 2 }))).toEqual(['low', 'high-a']);
    expect(ids(page({ minFitScore: 70 }))).toEqual(['high-a', 'high-b', 'shared']);
  });
  it('orders numerically across the full result with unassessed last and stable ties', () => {
    expect(ids(page())).toEqual(['high-a', 'high-b', 'shared', 'low', 'zero', 'bob-only', 'unassessed']);
    expect(page().totalNumber).toBe(7);
  });
  it('sorts before pagination and returns every row once across pages', () => {
    const pages = [1, 2, 3, 4].map((number) => page({ page: number, pageSize: 2 }));
    expect(pages.every((result) => result.totalNumber === 7)).toBe(true);
    expect(pages.flatMap(ids)).toEqual(ids(page()));
    expect(ids(pages[0])).toEqual(['high-a', 'high-b']);
  });
  it('keeps unassessed last when ascending, after a genuine zero score', () => {
    expect(ids(page({ sortDir: 'asc' }))).toEqual([
      'zero',
      'low',
      'shared',
      'high-a',
      'high-b',
      'bob-only',
      'unassessed',
    ]);
  });
  it('uses the acting user scores even for admins or listings owned by someone else', () => {
    expect(ids(page({ isAdmin: true }))).toEqual([
      'private',
      'high-a',
      'high-b',
      'shared',
      'low',
      'zero',
      'bob-only',
      'unassessed',
    ]);
    expect(ids(page({ userId: 'bob' }))).toEqual(['bob-only', 'shared', 'private']);
    // Bob's high score on an Alice listing cannot move it above her own higher-scored listings.
    expect(ids(page()).indexOf('low')).toBeGreaterThan(ids(page()).indexOf('shared'));
  });
  it('keeps filters/counts/other sorts unchanged and never returns private model result JSON', () => {
    expect(ids(page({ freeTextFilter: 'low' }))).toEqual(['low']);
    expect(page({ freeTextFilter: 'low' }).totalNumber).toBe(1);
    expect(ids(page({ sortField: 'created_at' }))[0]).toBe('bob-only');
    expect(page().result.every((row) => !('result' in row) && !('fit' in row))).toBe(true);
  });
  it('does not let sort fields, directions or user ids become SQL', () => {
    expect(ids(page({ sortField: 'fit_score; DROP TABLE listings;' }))[0]).toBe('bob-only');
    expect(ids(page({ sortDir: 'desc; DROP TABLE listings;' }))).toEqual(ids(page({ sortDir: 'asc' })));
    expect(page({ userId: "alice' OR 1=1 --" }).totalNumber).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM listings').get().n).toBe(8);
  });
});

describe('minimum saved listing fit', () => {
  it('excludes all-unknown null scores from a zero floor and sorts them after actual zero', () => {
    db.prepare(
      "UPDATE apartment_fit_results SET result=json_set(result, '$.score', NULL, '$.hardFailure', json('false')) WHERE user_id='alice' AND listing_id='high-a'",
    ).run();
    expect(ids(page({ minFitScore: 0 }))).toEqual(['high-b', 'shared', 'low', 'zero']);
    for (const sortDir of ['asc', 'desc']) {
      const result = ids(page({ sortDir }));
      expect(result.indexOf('high-a')).toBeGreaterThan(result.indexOf('zero'));
    }
  });
  it('filters before pagination and counts only matches, including the threshold', () => {
    const result = page({ minFitScore: 70, pageSize: 2 });
    expect(result.totalNumber).toBe(3);
    expect(ids(result)).toEqual(['high-a', 'high-b']);
    expect(ids(page({ minFitScore: 70, pageSize: 2, page: 2 }))).toEqual(['shared']);
    const byDate = ids(page({ minFitScore: 70, sortField: 'created_at' }));
    expect(byDate[0]).toBe('shared');
    expect(byDate.slice(1).sort()).toEqual(['high-a', 'high-b']);
  });
  it('keeps real zero but excludes unassessed and other-user-only scores', () => {
    expect(ids(page({ minFitScore: 0 }))).toEqual(['high-a', 'high-b', 'shared', 'low', 'zero']);
    expect(ids(page({ minFitScore: 90, isAdmin: true }))).toEqual(['private', 'high-a', 'high-b']);
    expect(ids(page({ minFitScore: 90, userId: 'bob' }))).toEqual(['bob-only']);
  });
  it.each([null, undefined, NaN, -1, 101, '70; DROP TABLE listings;'])('ignores invalid floor %s', (minFitScore) => {
    expect(ids(page({ minFitScore }))).toEqual(ids(page()));
  });
  it('uses exactly the same filter for bulk deletion', () => {
    expect(deleteListingsByFilter({ userId: 'alice', minFitScore: 70 }).changes).toBe(3);
    expect(ids(page())).toEqual(['low', 'zero', 'bob-only', 'unassessed']);
    expect(db.prepare("SELECT manually_deleted FROM listings WHERE id = 'private'").get().manually_deleted).toBe(0);
  });
});

vi.mock('../../lib/services/storage/searchEligibilityStorage.js', () => ({
  recheckSearchEligibility: vi.fn(),
  matchingSearchListings: (rows) => rows,
}));
