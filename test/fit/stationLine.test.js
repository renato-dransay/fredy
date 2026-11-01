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
const subwayRoute = {
  type: 'relation',
  id: 500,
  tags: { type: 'route', route: 'subway', ref: 'U8' },
  members: [{ type: 'node', ref: station.id, role: 'stop' }],
};
beforeEach(clearStationLineCache);

describe('rail-line-aware walking fit', () => {
  it('verifies any-line subway membership and a real walk without accepting a nearby S-Bahn or light rail', async () => {
    const suburban = { ...station, id: 124, tags: { railway: 'station', name: 'S-Bahn' } };
    const lightRail = { ...station, id: 125, tags: { railway: 'station', name: 'Light rail' } };
    const request = vi.fn(async () =>
      response([
        subwayRoute,
        station,
        suburban,
        lightRail,
        {
          ...subwayRoute,
          id: 501,
          tags: { type: 'route', route: 'train', ref: 'S1' },
          members: [{ type: 'node', ref: suburban.id }],
        },
        {
          ...subwayRoute,
          id: 502,
          tags: { type: 'route', route: 'light_rail', ref: 'M4' },
          members: [{ type: 'node', ref: lightRail.id }],
        },
      ]),
    );
    const route = vi.fn(async () => ({ answered: true, route: { minutes: 8 } }));
    const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, { request, route });
    expect(result).toMatchObject({ verdict: 'met', confidence: 1 });
    expect(route).toHaveBeenCalledTimes(1);
    const query = new URLSearchParams(request.mock.calls[0][1].body).get('data');
    expect(query).toContain('[route="subway"]');
    expect(query).not.toContain('light_rail');
    expect(query).not.toContain('[ref="*"]');
    expect(result.evidence[0].text).toContain('U-Bahn');
  });
  it('keeps an any-line lookup unknown when there is no verified subway membership', async () => {
    const route = vi.fn();
    const result = await evaluateStationLine({ line: '*', maxWalkMinutes: 10 }, listing, {
      request: async () => response([station, { ...subwayRoute, tags: { type: 'route', route: 'train', ref: 'S1' } }]),
      route,
    });
    expect(result.verdict).toBe('unknown');
    expect(route).not.toHaveBeenCalled();
  });
  it('requires line membership in the query and an actual walking route', async () => {
    const request = vi.fn(async () => response([station]));
    const route = vi.fn(async () => ({ answered: true, route: { minutes: 8 } }));
    const result = await evaluateStationLine(criterion, listing, { request, route });
    expect(result).toMatchObject({ verdict: 'met', confidence: 1 });
    expect(result.evidence[0].text).toContain('8 minutes walking');
    const query = new URLSearchParams(request.mock.calls[0][1].body).get('data');
    expect(query).toContain('[ref="U2"]');
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
