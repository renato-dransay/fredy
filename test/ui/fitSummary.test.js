/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '../../ui/src/locales/en.json';

const state = vi.hoisted(() => ({ result: null, locale: 'en-US' }));
vi.mock('react', async (original) => {
  const react = await original();
  return {
    ...react,
    useState: (initial) =>
      react.useState(
        initial && typeof initial === 'object' && 'result' in initial ? (state.result ?? initial) : initial,
      ),
  };
});
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({
  useTranslation:
    () =>
    (key, values = {}) =>
      Object.entries(values).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        en[key] ?? key,
      ),
  useLocale: () => state.locale,
}));
vi.mock('../../ui/src/services/state/store.js', () => ({ useSelector: (selector) => selector({ provider: [] }) }));
vi.mock('react-router', () => ({
  Link: ({ to, children, ...props }) => createElement('a', { href: to, ...props }, children),
}));
vi.mock('@douyinfe/semi-ui-19', () => ({
  Button: ({ children, onClick }) => createElement('button', { onClick }, children),
}));
vi.mock('@douyinfe/semi-icons', () => ({ IconMapPin: () => null, IconPaperclip: () => null }));
vi.mock('../../ui/src/services/searchWorkspaceClient.js', () => ({ loadFit: vi.fn(), evaluateFit: vi.fn() }));
for (const name of [
  'ListingPhoto',
  'StatusControl',
  'AffordabilityChip',
  'PriceChangeBadge',
  'PricePerSqmBadge',
  'ScamBadge',
  'ExclusiveBadge',
  'WatchToggle',
  'ListingActions',
]) {
  vi.doMock(`../../ui/src/components/listings/${name}.jsx`, () => ({ default: () => null }));
}
vi.doMock('../../ui/src/components/transit/CommuteBadge.jsx', () => ({ default: () => null }));

const { default: FitSummary } = await import('../../ui/src/components/searchWorkspace/FitSummary.jsx');
const { default: FitCard } = await import('../../ui/src/components/searchWorkspace/FitCard.jsx');
const { default: ListingsTable } = await import('../../ui/src/components/table/ListingsTable.jsx');
const { default: ListingsGrid } = await import('../../ui/src/components/grid/listings/ListingsGrid.jsx');
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const summary = { score: 90, coverage: 40, hardFailure: true, hardUnknown: true, stale: true };

// Render the actual components, rather than testing strings in their source files.
describe('Jev result display', () => {
  it.each([
    [0, 'low', '0'],
    [49, 'low', '4.9'],
    [50, 'medium', '5'],
    [79, 'medium', '7.9'],
    [80, 'high', '8'],
    [100, 'high', '10'],
  ])('shows stored score %s on a colored ten-point scale', (score, tone, value) => {
    const html = render(FitSummary, {
      summary: { score, coverage: 100, hardFailure: false, hardUnknown: false, stale: false },
    });
    expect(html).toContain(`Jev ${value} / 10`);
    expect(html).toContain(`fitSummary__score--${tone}`);
    expect(html).not.toContain('/ 100');
  });
  it.each([
    [{ hardFailure: true }, 'low'],
    [{ hardUnknown: true }, 'medium'],
    [{ stale: true }, 'medium'],
  ])('never gives an unresolved or failed must-have a green score: %j', (flags, tone) => {
    const html = render(FitSummary, { summary: { score: 95, coverage: 70, ...flags } });
    expect(html).toContain(`fitSummary__score--${tone}`);
    expect(html).not.toContain('fitSummary__score--high');
  });
  it('renders every secondary status as a small chip, including unassessed', () => {
    const html = render(FitSummary, { summary });
    for (const [tone, text] of [
      ['neutral', '40% assessed'],
      ['warning', 'Out of date'],
      ['failure', 'Must-have unmet'],
      ['warning', 'Must-haves unverified'],
    ]) {
      expect(html).toContain(`<span class="fitSummary__chip fitSummary__chip--${tone}" title="${text}">${text}</span>`);
    }
    expect(render(FitSummary, { summary: null })).toContain('class="fitSummary__chip fitSummary__chip--neutral"');
  });
  it('formats the decimal for the active locale and keeps stored scores untouched', () => {
    const value = { score: 71, coverage: 40 };
    state.locale = 'de-DE';
    try {
      expect(render(FitSummary, { summary: value })).toContain('Jev 7,1 / 10');
      expect(value.score).toBe(71);
    } finally {
      state.locale = 'en-US';
    }
  });

  it('does not claim a listing is unassessed before its saved receipt has loaded', () => {
    state.result = null;
    const html = render(FitCard, { listingId: 'one', listing: { id: 'one' } });
    expect(html).toContain('Loading');
    expect(html).not.toContain(en['search.noAssessment']);
  });
  it('distinguishes a missing assessment from a genuine zero score', () => {
    expect(render(FitSummary, { summary: null })).toContain('Not assessed');
    expect(render(FitSummary, { summary: null })).not.toContain('/ 10');
    const html = render(FitSummary, { summary: { ...summary, score: 0 } });
    expect(html).toContain('Jev 0 / 10');
    expect(html).not.toContain('Not assessed');
  });
  it('keeps stale, failed and unknown must-have warnings visible next to even a high score', () => {
    const html = render(FitSummary, { summary });
    for (const value of ['Jev 9 / 10', '40%', 'Out of date', 'Must-have unmet', 'Must-haves unverified'])
      expect(html).toContain(value);
  });
  it.each([
    ['table', ListingsTable],
    ['grid', ListingsGrid],
  ])('renders the saved receipt and unassessed state in the actual %s layout', (_name, component) => {
    const html = render(component, {
      listings: [
        { id: 'one', title: 'Assessed flat', is_active: 1, fitSummary: summary },
        { id: 'two', title: 'New flat', is_active: 1, fitSummary: null },
      ],
    });
    for (const value of [
      'Assessed flat',
      'New flat',
      'Jev 9 / 10',
      'Must-have unmet',
      'Must-haves unverified',
      'Not assessed',
    ])
      expect(html).toContain(value);
  });
  it('renders pros, cons and unverified chips without the evidence report', () => {
    state.result = {
      stale: true,
      result: {
        ...summary,
        model: 'typesafe/jev-1.14-test',
        evaluatedAt: '2026-11-01T12:00:00Z',
        criteria: [
          { id: 'rooms', text: 'At least 3 rooms', verdict: 'met', required: false },
          { id: 'budget', text: 'Within budget', verdict: 'unmet', required: true },
          {
            id: 'dogs',
            text: 'Dog must be permitted',
            required: true,
            verdict: 'unknown',
            confidence: 0,
            evidence: [{ source: 'listing.description:0', text: 'Ask the landlord about pets.' }],
          },
        ],
      },
    };
    const html = render(FitCard, { listingId: 'one', listing: { id: 'one' } });
    for (const value of [
      'Jev fit assessment',
      'Jev 9 / 10',
      'Must-have unmet',
      'Must-haves unverified',
      'Dog must be permitted',
      'At least 3 rooms',
      'Within budget',
      'Pros',
      'Cons',
      'Unverified',
    ])
      expect(html).toContain(value);
    for (const [verdict, text] of [
      ['met', 'At least 3 rooms'],
      ['unmet', 'Within budget'],
      ['unknown', 'Dog must be permitted'],
    ]) {
      expect(html).toContain(`<li class="fitCard__chip fitCard__chip--${verdict}" title="${text}">`);
      expect(html).toContain(`aria-labelledby="fit-one-${verdict}"`);
    }
    expect(html.match(/aria-label="Must-have"/g)).toHaveLength(2);
    for (const reportText of [
      '<details',
      'Ask the landlord about pets.',
      'listing.description:0',
      en['search.scoreHelp'],
      en['search.hardFailure'],
      en['search.hardUnknown'],
      en['search.stale'],
      'confidence',
      'typesafe/jev-1.14-test',
    ])
      expect(html).not.toContain(reportText);
    expect(html).toContain('/settings/search-profile');
    state.result = null;
  });
  it('hides empty groups and keeps long or HTML-like requirements as escaped chip text', () => {
    const text = '<script>unsafe()</script> ' + 'A long apartment requirement '.repeat(40);
    state.result = {
      result: {
        score: 100,
        coverage: 100,
        criteria: [{ id: 'long', text, verdict: 'met' }],
      },
    };
    const html = render(FitCard, { listingId: 'one', listing: { id: 'one' } });
    expect(html).toContain('Pros');
    expect(html).not.toContain('fitCard__chip--unmet');
    expect(html).not.toContain('fitCard__chip--unknown');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).toContain('class="fitCard__chipText"');
    state.result = null;
  });
});
