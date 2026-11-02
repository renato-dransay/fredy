/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node-fetch', () => ({ default: request }));
vi.mock('p-throttle', () => ({ default: () => (fn) => fn }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ motisBaseUrl: 'https://routing.example/api/' }),
}));
import { fetchSubwayStops } from '../../lib/services/transit/transitousClient.js';
const stop = { name: 'S+U station', stopId: 'id', lat: 52.5, lon: 13.4, modes: ['SUBURBAN', 'SUBWAY'] };
beforeEach(() => request.mockReset());
describe('subway platform discovery', () => {
  it('requires explicit SUBWAY mode and uses the configured endpoint with ungrouped platforms', async () => {
    request.mockResolvedValue({
      ok: true,
      json: async () => [
        ...Array(220).fill({ ...stop, stopId: 'bus', modes: ['BUS'] }),
        stop,
        { ...stop, stopId: 's-bahn', modes: ['SUBURBAN'] },
      ],
    });
    const result = await fetchSubwayStops({ lat: 52.5, lng: 13.4, radiusMeters: 1800 });
    expect(result).toEqual({ complete: true, stations: [{ name: stop.name, stopId: 'id', lat: 52.5, lng: 13.4 }] });
    const url = new URL(request.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://routing.example/api/v6/map/stops');
    expect(url.searchParams.get('modes')).toBe('SUBWAY');
    expect(url.searchParams.get('grouped')).toBe('false');
    expect(Number(url.searchParams.get('min').split(',')[0])).toBeLessThan(52.5);
    expect(Number(url.searchParams.get('max').split(',')[1])).toBeGreaterThan(13.4);
  });
  it('keeps malformed, truncated and unavailable responses distinct from complete station evidence', async () => {
    request.mockResolvedValue({ ok: true, json: async () => [{ ...stop, lat: null }] });
    expect(await fetchSubwayStops({ lat: 52.5, lng: 13.4, radiusMeters: 1800 })).toEqual({
      stations: [],
      complete: false,
    });
    request.mockResolvedValue({ ok: true, json: async () => Array(201).fill(stop) });
    expect((await fetchSubwayStops({ lat: 52.5, lng: 13.4, radiusMeters: 1800 })).complete).toBe(false);
    request.mockResolvedValue({ ok: false, status: 503 });
    expect(await fetchSubwayStops({ lat: 52.5, lng: 13.4, radiusMeters: 1800 })).toBeNull();
  });
});
