/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { describe, it, expect } from 'vitest';
import { normalizeProfile } from '../../lib/services/fit/profile.js';
import {
  evaluateFit,
  evaluateNumeric,
  fitEvidenceHash,
  isFitStale,
  summarizeFit,
} from '../../lib/services/fit/evaluate.js';

const requirement = (extra = {}) => ({
  id: 'c1',
  text: 'Two bedrooms',
  kind: 'semantic',
  weight: 2,
  required: true,
  ...extra,
});

describe('apartment requirements validation', () => {
  it('keeps a document and separate bedroom and room requirements without inventing facts', () => {
    const result = normalizeProfile({
      document: 'Two bedrooms, unfurnished',
      criteria: [requirement(), requirement({ id: 'rooms', text: 'At least 3 rooms', kind: 'min_rooms', value: 3 })],
    });
    expect(result.document).toBe('Two bedrooms, unfurnished');
    expect(result.criteria.map((c) => c.kind)).toEqual(['semantic', 'min_rooms']);
  });
  it.each([
    { document: 'é'.repeat(17000), criteria: [] },
    { criteria: [requirement(), requirement()] },
    { criteria: [requirement({ weight: 0 })] },
    { criteria: [requirement({ id: 123 })] },
    { criteria: [requirement({ weight: 1.5 })] },
    { criteria: [requirement({ required: 'yes' })] },
    { criteria: [requirement({ kind: 'max_price', value: NaN })] },
    { criteria: [requirement({ kind: 'min_rooms', value: -1 })] },
    { criteria: [requirement({ kind: 'station_line', line: 'U2"];out;', maxWalkMinutes: 10 })] },
    { criteria: [requirement({ kind: 'station_line', line: 'U2', maxWalkMinutes: 100 })] },
    { criteria: Array.from({ length: 31 }, (_, i) => requirement({ id: `c${i}` })) },
  ])('rejects malformed or unbounded input %#', (input) => {
    expect(() => normalizeProfile(input)).toThrow();
  });
  it('normalizes a safe transit-line rule', () => {
    const result = normalizeProfile({
      criteria: [requirement({ kind: 'station_line', line: ' u2 ', maxWalkMinutes: 10 })],
    });
    expect(result.criteria[0].line).toBe('U2');
  });
});

describe('fit scoring and provenance', () => {
  it('unknown hard requirements remain unknown and reduce conservative score', () => {
    expect(
      summarizeFit([requirement({ verdict: 'met' }), requirement({ id: 'b', verdict: 'unknown', weight: 3 })]),
    ).toEqual({ score: 40, coverage: 40, hardFailure: false, hardUnknown: true });
  });
  it('a low-weight hard failure cannot be hidden by a high score', () => {
    const result = summarizeFit([
      requirement({ verdict: 'met', weight: 10 }),
      requirement({ verdict: 'unmet', weight: 1 }),
    ]);
    expect(result.score).toBe(91);
    expect(result.hardFailure).toBe(true);
  });
  it('missing numerical fields do not silently pass', () => {
    expect(evaluateNumeric(requirement({ kind: 'min_rooms', value: 3 }), {}).verdict).toBe('unknown');
    expect(evaluateNumeric(requirement({ kind: 'min_rooms', value: 3 }), { rooms: 2 }).verdict).toBe('unmet');
    expect(evaluateNumeric(requirement({ kind: 'max_price', value: 1500 }), { price: 1400 }).verdict).toBe('met');
  });
  it('combines typed semantic, numeric and actual station evidence in original criterion order', async () => {
    const profile = {
      version: 1,
      document: 'Requirements',
      criteria: [
        requirement({ id: 'price', kind: 'max_price', value: 1500 }),
        requirement(),
        requirement({ id: 'metro', kind: 'station_line', line: 'U2', maxWalkMinutes: 10 }),
      ],
    };
    const listing = { price: 1400, rooms: 3, description: 'Two bedrooms; unfurnished' };
    const result = await evaluateFit(profile, listing, {
      semantic: async (criteria) => ({
        model: 'typesafe/jev-1.14-test',
        results: criteria.map((c) => ({
          ...c,
          verdict: 'met',
          confidence: 0.9,
          evidence: [{ source: 'listing.description:0', text: listing.description }],
        })),
      }),
      station: async () => ({ verdict: 'unknown', confidence: 0, evidence: [] }),
    });
    expect(result.criteria.map((c) => c.id)).toEqual(['price', 'c1', 'metro']);
    expect(result).toMatchObject({ score: 67, coverage: 67, hardUnknown: true, profileVersion: 1 });
    expect(result.evidenceHash).toBe(fitEvidenceHash(profile, listing));
    expect(isFitStale(result, profile, listing)).toBe(false);
    expect(isFitStale(result, { ...profile, version: 2 }, listing)).toBe(true);
    expect(isFitStale(result, profile, { ...listing, price: 1550 })).toBe(true);
    expect(isFitStale(result, profile, listing, Date.now() + 2 * 86400000)).toBe(true);
  });
  it('ignores personal notes in the listing evidence fingerprint', () => {
    expect(fitEvidenceHash({}, { title: 'Flat', notes: 'one' })).toBe(
      fitEvidenceHash({}, { title: 'Flat', notes: 'two' }),
    );
  });
  it('retries unknown station evidence after a minute while successful fits retain the daily cache', () => {
    const profile = { version: 1, criteria: [], document: '' };
    const listing = { rooms: 3 };
    const result = {
      evidenceHash: fitEvidenceHash(profile, listing),
      evaluatedAt: new Date().toISOString(),
      criteria: [{ kind: 'station_line', verdict: 'unknown' }],
    };
    expect(isFitStale(result, profile, listing, Date.now() + 30000)).toBe(false);
    expect(isFitStale(result, profile, listing, Date.now() + 61000)).toBe(true);
    result.criteria[0].verdict = 'met';
    expect(isFitStale(result, profile, listing, Date.now() + 61000)).toBe(false);
  });
});
