/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateStationLine, clearStationLineCache } from '../../lib/services/fit/stationLine.js';
const criterion = { line: 'U2', maxWalkMinutes: 10 };
const listing = { latitude: 52.5, longitude: 13.4 };
const station = { type: 'node', id: 123, lat: 52.501, lon: 13.401, tags: { railway: 'station', name: 'U2 station' } };
const response = (elements, extra = {}) => new Response(JSON.stringify({ elements, ...extra }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ overpassBaseUrl: 'https://overpass.example/api/interpreter/' }),
}));
beforeEach(clearStationLineCache);

describe('rail-line-aware walking fit', () => {
  it('uses explicit subway stops and real walking routes without the unavailable Overpass dependency', async () => {
    const subwayStops = vi.fn(async () => ({
      stations: [{ name: 'U-Bahn', lat: station.lat, lng: station.lon, stopId: 'subway-1' }],
      complete: true,
    }));
    const request = vi.fn();
    const route = vi.fn(async () => ({ answered: true, route: { minutes: 8 } }));
    const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
      subwayStops,
      request,
      route,
    });
    expect(result).toMatchObject({ verdict: 'met', confidence: 1 });
    expect(route).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(result.evidence[0].text).toContain('Transitous SUBWAY stop subway-1');
  });
  it('keeps a missing or failed subway lookup unknown', async () => {
    for (const answer of [null, { stations: [], complete: true }]) {
      clearStationLineCache();
      const matrix = vi.fn();
      const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
        subwayStops: async () => answer,
        matrix,
      });
      expect(result.verdict).toBe('unknown');
      expect(matrix).not.toHaveBeenCalled();
    }
  });
  it('routes all candidates together, including a match beyond the first three', async () => {
    const stations = Array.from({ length: 4 }, (_, i) => ({
      name: `U${i}`,
      lat: station.lat,
      lng: station.lon,
      stopId: `stop-${i}`,
    }));
    const matrix = vi.fn(async () => [900, 1000, 700, 480].map((seconds) => ({ seconds })));
    const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
      subwayStops: async () => ({ stations, complete: true }),
      matrix,
    });
    expect(result.verdict).toBe('met');
    expect(result.evidence[0].source).toBe('station:stop-3');
    expect(matrix).toHaveBeenCalledTimes(1);
    expect(matrix.mock.calls[0][0].destinations).toHaveLength(4);
  });
  it.each([
    [600, 'met'],
    [601, 'unmet'],
    [null, 'unknown'],
  ])('compares exact walking seconds %s at the cutoff', async (seconds, verdict) => {
    const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
      subwayStops: async () => ({
        stations: [{ name: 'U', lat: station.lat, lng: station.lon, stopId: 'subway' }],
        complete: true,
      }),
      matrix: async () => [{ seconds }],
    });
    expect(result.verdict).toBe(verdict);
  });
  it('does not declare failure from an incomplete matrix or station coverage', async () => {
    for (const [complete, durations] of [
      [true, []],
      [false, [{ seconds: 700 }]],
    ]) {
      clearStationLineCache();
      const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
        subwayStops: async () => ({
          stations: [{ name: 'U', lat: station.lat, lng: station.lon, stopId: 'subway' }],
          complete,
        }),
        matrix: async () => durations,
      });
      expect(result.verdict).toBe('unknown');
    }
  });
  it('requires line membership in the query and an actual walking route', async () => {
    const request = vi.fn(async () => response([station]));
    const route = vi.fn(async () => ({ answered: true, route: { minutes: 8 } }));
    const result = await evaluateStationLine(criterion, listing, { request, route });
    expect(result).toMatchObject({ verdict: 'met', confidence: 1 });
    expect(result.evidence[0].text).toContain('8 minutes walking');
    const query = new URLSearchParams(request.mock.calls[0][1].body).get('data');
    expect(query).toContain('[ref="U2"]');
    expect(request.mock.calls[0][0]).toBe('https://overpass.example/api/interpreter');
    expect(query).toContain('node(r)');
    expect(route.mock.calls[0][0]).toMatchObject({ mode: 'WALK', toLat: station.lat });
  });
  it('does not assume a nearby generic station or straight-line distance proves a match', async () => {
    const result = await evaluateStationLine(criterion, listing, {
      request: async () => response([station]),
      route: async () => ({ answered: false, route: null }),
    });
    expect(result.verdict).toBe('unknown');
  });
  it('returns unmet only after complete candidate coverage and successful walking routes', async () => {
    const result = await evaluateStationLine(criterion, listing, {
      request: async () => response([station]),
      route: async () => ({ answered: true, route: { minutes: 16 } }),
    });
    expect(result.verdict).toBe('unmet');
  });
  it('keeps incomplete station lookup unknown', async () => {
    expect(
      (
        await evaluateStationLine(criterion, listing, {
          request: async () => response([], { remark: 'timeout' }),
          route: vi.fn(),
        })
      ).verdict,
    ).toBe('unknown');
  });
  it('does not make network calls without valid coordinates or with injected line syntax', async () => {
    const request = vi.fn();
    expect((await evaluateStationLine(criterion, {}, { request })).verdict).toBe('unknown');
    expect((await evaluateStationLine({ line: 'U2"];out;', maxWalkMinutes: 10 }, listing, { request })).verdict).toBe(
      'unknown',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('stops waiting for a blocked shared walking queue at the evaluation deadline', async () => {
    const controller = new AbortController();
    const route = async () => {
      controller.abort();
      return new Promise(() => {});
    };
    const result = await evaluateStationLine(criterion, listing, {
      request: async () => response([station]),
      route,
      signal: controller.signal,
    });
    expect(result.verdict).toBe('unknown');
  });
  it('deduplicates concurrent identical lookups and reuses the cached actual route', async () => {
    const request = vi.fn(async () => response([station]));
    const route = vi.fn(async () => ({ answered: true, route: { minutes: 8 } }));
    const [a, b] = await Promise.all([
      evaluateStationLine(criterion, listing, { request, route }),
      evaluateStationLine(criterion, listing, { request, route }),
    ]);
    expect(a).toEqual(b);
    expect(request).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
  });
});

it('does not certify walking time from an approximate neighborhood position', async () => {
  const subwayStops = vi.fn();
  const result = await evaluateStationLine(
    { line: '*', maxWalkMinutes: 10 },
    { latitude: 52.5, longitude: 13.4, location_source: 'approximate' },
    { subwayStops },
  );
  expect(result.verdict).toBe('unknown');
  expect(result.evidence[0].text).toContain('approximate');
  expect(subwayStops).not.toHaveBeenCalled();
});

it('checks platforms beyond the first batch before declaring a complete verdict', async () => {
  const stations = Array.from({ length: 60 }, (_, i) => ({ name: `U${i}`, lat: 52.501, lng: 13.401, stopId: `${i}` }));
  const matrix = vi.fn(async ({ destinations }) => destinations.map(() => ({ seconds: 900 })));
  const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
    subwayStops: async () => ({ stations, complete: true }),
    matrix,
  });
  expect(result.verdict).toBe('unmet');
  expect(matrix.mock.calls.map(([args]) => args.destinations.length)).toEqual([50, 10]);
  expect(result.evidence).toHaveLength(60);
});
it('expands an empty complete local search and uses actual walks to outer-district subway stops', async () => {
  const subwayStops = vi
    .fn()
    .mockResolvedValueOnce({ stations: [], complete: true })
    .mockResolvedValueOnce({ stations: [{ name: 'Distant U', lat: 52.52, lng: 13.4, stopId: 'far' }], complete: true });
  const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
    subwayStops,
    matrix: async () => [{ seconds: 3000 }],
  });
  expect(subwayStops.mock.calls.map(([args]) => args.radiusMeters)).toEqual([1800, 3000]);
  expect(result.verdict).toBe('unmet');
  expect(result.evidence.some((e) => e.text.includes('50 minutes walking'))).toBe(true);
});

it('keeps incomplete inner coverage unknown even when distant routes exceed the limit', async () => {
  const subwayStops = vi.fn(async () => ({ stations: [], complete: false }));
  const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, { subwayStops });
  expect(result.verdict).toBe('unknown');
  expect(subwayStops).toHaveBeenCalledTimes(1);
});
it('does not let an unavailable distant platform hide complete local absence evidence', async () => {
  const subwayStops = vi
    .fn()
    .mockResolvedValueOnce({ stations: [], complete: true })
    .mockResolvedValueOnce({
      stations: [
        { name: 'Far U', lat: 52.52, lng: 13.4, stopId: 'far' },
        { name: 'Other platform', lat: 52.52, lng: 13.4, stopId: 'other' },
      ],
      complete: true,
    });
  const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
    subwayStops,
    matrix: async () => [{ seconds: 1800 }, { seconds: null }],
  });
  expect(result.verdict).toBe('unmet');
  expect(result.evidence[0].text).toContain('complete local subway lookup');
});
