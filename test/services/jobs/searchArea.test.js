/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { searchAreaFromImmoScout } from '../../../lib/services/jobs/searchArea.js';

/** Produce a synthetic portal-format drawing without embedding anybody's saved search area. */
function urlFor(points) {
  let previous = [0, 0];
  const polyline = points
    .map((pair) =>
      pair
        .map((value, index) => {
          const current = Math.round(value * 1e5);
          const difference = current - previous[index];
          previous[index] = current;
          let number = difference < 0 ? -difference * 2 - 1 : difference * 2;
          let encoded = '';
          while (number >= 32) {
            encoded += String.fromCharCode(((number % 32) | 32) + 63);
            number = Math.floor(number / 32);
          }
          return encoded + String.fromCharCode(number + 63);
        })
        .join(''),
    )
    .join('');
  const url = new URL('https://www.immobilienscout24.de/Suche/shape/wohnung-mieten');
  url.searchParams.set(
    'shape',
    Buffer.from(polyline).toString('base64').replaceAll('+', '_').replaceAll('/', '-').replaceAll('=', '.'),
  );
  return url.href;
}

describe('shared area derived from an existing portal drawing', () => {
  it('preserves precision and orientation and closes an open ring without widening it', () => {
    const area = searchAreaFromImmoScout(
      urlFor([
        [52.5, 13.3],
        [52.5, 13.5],
        [52.6, 13.5],
        [52.6, 13.3],
      ]),
    );
    const ring = area.features[0].geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual([13.3, 52.5]);
    expect(ring.at(-1)).toEqual(ring[0]);
    expect(booleanPointInPolygon([13.4, 52.55], area.features[0])).toBe(true);
    expect(booleanPointInPolygon([13.1, 52.55], area.features[0])).toBe(false);
  });
  it('keeps an already closed ring closed exactly once', () => {
    const area = searchAreaFromImmoScout(
      urlFor([
        [52.5, 13.3],
        [52.5, 13.5],
        [52.6, 13.4],
        [52.5, 13.3],
      ]),
    );
    expect(area.features[0].geometry.coordinates[0]).toHaveLength(4);
  });
  it.each([
    'https://example.com/?shape=???',
    'https://www.immobilienscout24.de/',
    'https://www.immobilienscout24.de/?shape=~~~',
  ])('rejects missing or invalid drawings instead of dropping the constraint', (url) => {
    expect(() => searchAreaFromImmoScout(url)).toThrow();
  });
});
