/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../lib/provider/immoscout.js';
import { config as atConfig } from '../../../lib/provider/immoscoutAt.js';

vi.mock('../../../lib/utils.js', async (original) => ({ ...(await original()), sleep: vi.fn(async () => {}) }));

const URL = 'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent&pagenumber=9';
const advert = (id, extra = {}) => ({
  type: 'EXPOSE_RESULT',
  item: {
    id,
    title: 'Wohnung',
    address: { line: 'Berlin' },
    attributes: [{ value: '1000 €' }, { value: '80 m²' }, { value: '3 Zi.' }],
    ...extra,
  },
});
const response = (pageNumber, items, numberOfPages = 2) => ({
  ok: true,
  json: async () => ({
    pageNumber,
    numberOfPages,
    resultListItems: items,
  }),
});

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('ImmoScout complete search pagination', () => {
  it('keeps concurrent search cursors independent', async () => {
    fetch.mockImplementation(async (value) => {
      const url = new globalThis.URL(value);
      const page = Number(url.searchParams.get('pagenumber'));
      const search = url.searchParams.get('search');
      return response(page, [advert(`${search}-${page}`)]);
    });
    const [first, second] = await Promise.all([
      config.getListings(`${URL}&search=a`),
      config.getListings(`${URL}&search=b`),
    ]);
    expect(first.map((x) => x.id)).toEqual(['a-1', 'a-2']);
    expect(second.map((x) => x.id)).toEqual(['b-1', 'b-2']);
  });
  it.each([config, atConfig])('starts at page one, follows pages and deduplicates adverts', async (provider) => {
    fetch
      .mockResolvedValueOnce(response(1, [advert('a'), advert('b')]))
      .mockResolvedValueOnce(response(2, [advert('b'), advert('c'), { type: 'AD' }]));
    expect((await provider.getListings(URL)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(fetch.mock.calls.map(([url]) => new globalThis.URL(url).searchParams.get('pagenumber'))).toEqual(['1', '2']);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps explicit exclusive state, label and epoch-ms expiry through normalization', async () => {
    fetch.mockResolvedValue(
      response(
        1,
        [
          advert('a', {
            paywallListing: {
              active: true,
              text: 'Noch exklusiv für Suchen+',
              earlyAccessExpiresAt: '2026-11-05T14:35:35+01:00',
            },
          }),
          advert('b'),
        ],
        1,
      ),
    );
    const rows = (await config.getListings(URL)).map(config.normalize);
    expect(rows[0]).toMatchObject({
      isExclusive: true,
      exclusiveLabel: 'Noch exklusiv für Suchen+',
      exclusiveUntil: Date.parse('2026-11-05T14:35:35+01:00'),
    });
    expect(rows[1]).toMatchObject({ isExclusive: false, exclusiveUntil: null });
    expect(config.normalize({ id: 'c' })).not.toHaveProperty('isExclusive');
  });

  it('accepts a genuinely empty search', async () => {
    fetch.mockResolvedValue(response(1, [], 0));
    expect(await config.getListings(URL)).toEqual([]);
  });

  it.each([429, 500])('rejects a failed later page (%s) rather than returning partial results', async (status) => {
    fetch
      .mockResolvedValueOnce(response(1, [advert('a')]))
      .mockResolvedValueOnce({ ok: false, status, statusText: 'failed', text: async () => 'unavailable' });
    await expect(config.getListings(URL)).rejects.toThrow(String(status));
  });

  it.each([
    ['wrong page', response(1, [advert('b')])],
    ['repeated results', response(2, [advert('a')])],
    ['empty advertised page', response(2, [])],
    ['too many pages', response(2, [advert('b')], 201)],
    ['malformed items', response(2, null)],
    ['invalid count', response(2, [], -1)],
    [
      'bad JSON',
      {
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      },
    ],
  ])('rejects %s', async (_label, second) => {
    fetch.mockResolvedValueOnce(response(1, [advert('a')])).mockResolvedValueOnce(second);
    await expect(config.getListings(URL)).rejects.toThrow();
  });

  it('bounds detail requests and surfaces rate limits', async () => {
    fetch.mockResolvedValue({ ok: false, status: 429 });
    await expect(config.fetchDetails({ link: 'https://www.immobilienscout24.de/expose/123' })).rejects.toThrow('429');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(config.detailFetchDelayMs).toBeGreaterThan(0);
  });
});
