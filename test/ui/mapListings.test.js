/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { fitTone } from '../../ui/src/services/listings/fitPresentation.js';
import { groupFitTone, listingsInViewport, hasMapPosition } from '../../ui/src/views/listings/mapUtils.js';

const assessed = (score, extra = {}) => ({ score, ...extra });
const at = (id, longitude, latitude, fitSummary = null) => ({ id, longitude, latitude, fitSummary });

describe('fit pin presentation', () => {
  it.each([
    [null, 'unassessed'],
    [{ score: NaN }, 'unassessed'],
    [assessed(0), 'low'],
    [assessed(49), 'low'],
    [assessed(50), 'medium'],
    [assessed(79), 'medium'],
    [assessed(80), 'high'],
    [assessed(100), 'high'],
  ])('classifies %j as %s', (summary, expected) => {
    expect(fitTone(summary)).toBe(expected);
  });
  it('never paints a failed, unknown or stale assessment green', () => {
    expect(fitTone(assessed(100, { hardFailure: true }))).toBe('low');
    expect(fitTone(assessed(100, { hardUnknown: true }))).toBe('medium');
    expect(fitTone(assessed(100, { stale: true }))).toBe('medium');
  });
  it('marks mixed groups explicitly instead of hiding a low or unassessed result behind a good one', () => {
    expect(groupFitTone([at('a', 13, 52, assessed(90)), at('b', 13, 52, assessed(10))])).toBe('mixed');
    expect(groupFitTone([at('a', 13, 52, assessed(90)), at('b', 13, 52)])).toBe('mixed');
    expect(groupFitTone([at('a', 13, 52, assessed(90)), at('b', 13, 52, assessed(85))])).toBe('high');
  });
});

describe('visible map listings', () => {
  // Projection lets the same code work after rotation/pitch, unlike a geographical bounding box.
  const project = ([lng, lat]) => ({ x: lng * 10, y: lat * 10 });
  const rows = [
    at('west', -1.1, 5),
    at('inside', 5, 5),
    at('same-address', 5, 5),
    at('edge', 10, 10),
    at('east', 11, 5),
    at('north', 5, 11),
    at('invalid', null, 5),
  ];
  it('includes all adverts on a visible position, including edges; excludes outside and invalid positions', () => {
    expect(listingsInViewport(rows, project, 100, 100).map((row) => row.id)).toEqual([
      'inside',
      'same-address',
      'edge',
    ]);
  });
  it('shrinks and expands after zooming, and changes after a pan', () => {
    expect(
      listingsInViewport(rows, ([lng, lat]) => ({ x: lng * 20, y: lat * 20 }), 100, 100).map((row) => row.id),
    ).toEqual(['inside', 'same-address']);
    expect(listingsInViewport(rows, project, 120, 120).map((row) => row.id)).toEqual([
      'inside',
      'same-address',
      'edge',
      'east',
      'north',
    ]);
    expect(
      listingsInViewport(rows, ([lng, lat]) => ({ x: (lng - 6) * 10, y: lat * 10 }), 100, 100).map((row) => row.id),
    ).toEqual(['edge', 'east']);
  });
  it('does not bring filtered-out listings back or invent results before the canvas is sized', () => {
    expect(
      listingsInViewport(
        rows.filter((row) => row.id === 'inside'),
        project,
        100,
        100,
      ).map((row) => row.id),
    ).toEqual(['inside']);
    expect(listingsInViewport(rows, project, 0, 100)).toEqual([]);
    expect(listingsInViewport([], project, 100, 100)).toEqual([]);
  });
  it.each([
    [null, 52],
    [13, undefined],
    [-1, -1],
    [13, NaN],
    [Infinity, 52],
    [181, 52],
    [13, 91],
    ['13', 52],
  ])('rejects unusable coordinates %s, %s', (longitude, latitude) => {
    expect(hasMapPosition({ longitude, latitude })).toBe(false);
  });
});
