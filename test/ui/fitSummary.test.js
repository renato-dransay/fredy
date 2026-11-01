/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '../../ui/src/locales/en.json';

const state = vi.hoisted(() => ({ result: null }));
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
  useLocale: () => 'en-US',
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
  it('does not claim a listing is unassessed before its saved receipt has loaded', () => {
    state.result = null;
    const html = render(FitCard, { listingId: 'one', listing: { id: 'one' } });
    expect(html).toContain('Loading');
    expect(html).not.toContain(en['search.noAssessment']);
  });
  it('distinguishes a missing assessment from a genuine zero score', () => {
    expect(render(FitSummary, { summary: null })).toContain('Not assessed');
    expect(render(FitSummary, { summary: null })).not.toContain('/ 100');
    const html = render(FitSummary, { summary: { ...summary, score: 0 } });
    expect(html).toContain('Jev 0 / 100');
    expect(html).not.toContain('Not assessed');
  });
  it('keeps stale, failed and unknown must-have warnings visible next to even a high score', () => {
    const html = render(FitSummary, { summary });
    for (const value of ['Jev 90 / 100', '40%', 'Out of date', 'Must-have unmet', 'Must-haves unverified'])
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
      'Jev 90 / 100',
      'Must-have unmet',
      'Must-haves unverified',
      'Not assessed',
    ])
      expect(html).toContain(value);
  });
  it('renders the full result in the detail card with evidence inside an initially collapsed disclosure', () => {
    state.result = {
      stale: true,
      result: {
        ...summary,
        model: 'typesafe/jev-1.14-test',
        evaluatedAt: '2026-11-01T12:00:00Z',
        criteria: [
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
      'Jev 90 / 100',
      'Must-have unmet',
      'Must-haves unverified',
      'Dog must be permitted',
      'Ask the landlord about pets.',
      'View 1 criteria and evidence',
    ])
      expect(html).toContain(value);
    expect(html).toContain('<details class="searchWorkspace__criterionDetails">');
    expect(html).not.toContain('<details open');
    expect(html).toContain('/settings/search-profile');
    state.result = null;
  });
});
