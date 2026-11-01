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
beforeEach(clearStationLineCache);

describe('rail-line-aware walking fit', () => {
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
