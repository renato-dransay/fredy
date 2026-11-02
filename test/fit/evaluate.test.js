/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_JEV_INSTRUCTIONS } from '../../lib/services/fit/instructions.js';
import { normalizeProfile } from '../../lib/services/fit/profile.js';
import {
  evaluateFit,
  evaluateNumeric,
  fitEvidenceHash,
  isFitStale,
  summarizeFit,
  sourcesForListing,
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
  it('bounds custom instructions and chip metadata, preserving only supported values', () => {
    expect(
      normalizeProfile({
        criteria: [requirement({ label: '  Bedrooms ', icon: 'rooms' })],
        instructions: ' Be precise. ',
      }),
    ).toMatchObject({ instructions: 'Be precise.', criteria: [{ label: 'Bedrooms', icon: 'rooms' }] });
    for (const input of [
      { instructions: 'x'.repeat(4001), criteria: [] },
      { instructions: {}, criteria: [] },
      { criteria: [requirement({ label: 'x'.repeat(33) })] },
      { criteria: [requirement({ icon: 'arbitrary-html' })] },
    ])
      expect(() => normalizeProfile(input)).toThrow();
  });
  it('normalizes a safe transit-line rule', () => {
    const result = normalizeProfile({
      criteria: [requirement({ kind: 'station_line', line: ' u2 ', maxWalkMinutes: 10 })],
    });
    expect(result.criteria[0].line).toBe('U2');
  });
  it('supports an explicit any-subway rule without broadening other line names', () => {
    const result = normalizeProfile({
      criteria: [requirement({ kind: 'station_line', line: ' * ', maxWalkMinutes: 10, required: false })],
    });
    expect(result.criteria[0]).toMatchObject({ line: '*', required: false, maxWalkMinutes: 10 });
    expect(() =>
      normalizeProfile({
        criteria: [requirement({ kind: 'station_line', line: 'U*', maxWalkMinutes: 10 })],
      }),
    ).toThrow();
  });
});

describe('fit scoring and provenance', () => {
  it('passes explicit rent-basis and energy evidence without asserting a heating-inclusive warm rent', () => {
    const sources = sourcesForListing({ price: 1800, charges_included: 0, charges: 250, energy_class: 'B' });
    expect(sources.find((s) => s.source === 'listing.charges_included').text).toContain('excludes');
    expect(sources.find((s) => s.source === 'listing.charges').text).toContain('250');
    expect(sources.find((s) => s.source === 'listing.energy_class').text).toContain('B');
    expect(sources.find((s) => s.source === 'listing.charges').text).toContain('heating');
    expect(sources.some((s) => s.text.includes('2050'))).toBe(false);
    expect(sourcesForListing({ charges_included: null }).some((s) => s.source === 'listing.charges_included')).toBe(
      false,
    );
  });
  it('shares canonical evidence and invalidation between normalized provider rows and stored rows', () => {
    const normalized = { price: 1800, chargesIncluded: true, charges: 200, energyClass: 'C' };
    const stored = { price: 1800, charges_included: 1, charges: 200, energy_class: 'C' };
    expect(sourcesForListing(normalized)).toEqual(sourcesForListing(stored));
    expect(fitEvidenceHash({}, normalized)).toBe(fitEvidenceHash({}, stored));
    expect(fitEvidenceHash({}, stored)).not.toBe(fitEvidenceHash({}, { ...stored, energy_class: 'D' }));
    expect(fitEvidenceHash({}, stored)).not.toBe(fitEvidenceHash({}, { ...stored, charges_included: 0 }));
    expect(fitEvidenceHash({}, stored)).not.toBe(fitEvidenceHash({}, { ...stored, charges: 300 }));
  });
  it('keeps the whole bounded description when structured evidence consumes source slots', () => {
    const description = 'x'.repeat(19980) + 'Lease: permanent.';
    const sources = sourcesForListing({
      title: 'Flat',
      address: 'Berlin',
      price: 1800,
      size: 90,
      rooms: 3,
      charges_included: true,
      charges: 200,
      energy_class: 'B',
      description,
    });
    expect(sources.length).toBeLessThanOrEqual(30);
    expect(
      sources
        .filter((s) => s.source.startsWith('listing.description:'))
        .map((s) => s.text)
        .join(''),
    ).toBe(description);
  });
  it('unknown hard requirements remain unknown and reduce conservative score', () => {
    expect(
      summarizeFit([requirement({ verdict: 'met' }), requirement({ id: 'b', verdict: 'unknown', weight: 3 })]),
    ).toEqual({ score: 40, coverage: 40, hardFailure: false, hardUnknown: true });
  });
  it('retains the weighted score and flags a must-have failure independently', () => {
    const result = summarizeFit([
      requirement({ verdict: 'met', weight: 10 }),
      requirement({ verdict: 'unmet', weight: 1 }),
    ]);
    expect(result.score).toBe(91);
    expect(result.hardFailure).toBe(true);
  });
  it('keeps optional furnishing failures as preferences, but mandatory furnishing failures disqualify', () => {
    const criteria = [
      requirement({ id: 'kitchen', verdict: 'met', weight: 10 }),
      requirement({ id: 'unfurnished', verdict: 'unmet', required: false, weight: 2 }),
    ];
    expect(summarizeFit(criteria)).toMatchObject({ score: 83, hardFailure: false, coverage: 100 });
    criteria[1].required = true;
    expect(summarizeFit(criteria)).toMatchObject({ score: 83, hardFailure: true, coverage: 100 });
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

describe('custom evaluator instructions', () => {
  it('keeps default-guidance receipts fresh across migration, while customized guidance changes their hash', () => {
    const legacy = { document: '', criteria: [requirement()], version: 1 };
    const listing = { title: 'Flat' };
    expect(fitEvidenceHash({ ...legacy, instructions: DEFAULT_JEV_INSTRUCTIONS }, listing)).toBe(
      fitEvidenceHash(legacy, listing),
    );
    expect(fitEvidenceHash({ ...legacy, instructions: 'Different instructions' }, listing)).not.toBe(
      fitEvidenceHash(legacy, listing),
    );
  });
  it('passes private instructions to the real semantic entry point and binds freshness to them', async () => {
    const profile = {
      version: 1,
      document: '',
      instructions: 'Explicit long-term lease only.',
      criteria: [requirement()],
    };
    const listing = { title: 'Flat', description: 'An indefinite lease' };
    let received;
    const result = await evaluateFit(profile, listing, {
      semantic: async (criteria, sources, options) => {
        received = options;
        return { model: 'test', results: criteria.map((c) => ({ ...c, verdict: 'unknown', evidence: [] })) };
      },
    });
    expect(received).toEqual({ instructions: profile.instructions });
    expect(isFitStale(result, profile, listing)).toBe(false);
    expect(isFitStale(result, { ...profile, instructions: 'Different guidance.' }, listing)).toBe(true);
  });
});
