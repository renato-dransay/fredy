/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('react', () => ({
  useMemo: (create) => create(),
  useCallback: (callback) => callback,
  useRef: (value) => ({ current: value }),
}));
import { useUrlState, parseNumber, parseString } from '../../ui/src/hooks/useSearchParamState.js';
import { listingSortPatch } from '../../ui/src/services/listings/listingSort.js';
const schema = {
  page: { defaultValue: 1, codec: parseNumber },
  sort: { defaultValue: 'published_at', codec: parseString },
  dir: { defaultValue: 'desc', codec: parseString },
};
function urlState(url) {
  let params = new URLSearchParams(url);
  const set = vi.fn((update) => {
    params = update(params);
  });
  return { render: () => useUrlState([params, set], schema), url: () => params.toString(), set };
}

describe('listing sort through the real URL-state hook', () => {
  it('selects highest JEV scores on page one in one navigation, preserving search and filters', () => {
    const state = urlState('page=4&sort=price&dir=asc&q=balcony&active=true');
    state.render().setValues(listingSortPatch('fit_score'));
    expect(state.set).toHaveBeenCalledTimes(1);
    expect(state.render().values).toEqual({ page: 1, sort: 'fit_score', dir: 'desc' });
    const url = new URLSearchParams(state.url());
    expect(url.get('q')).toBe('balcony');
    expect(url.get('active')).toBe('true');
    // Descending is the URL default, so the same shared URL still opens in best-first order.
    expect(url.has('page')).toBe(false);
    expect(urlState(state.url()).render().values).toEqual({ page: 1, sort: 'fit_score', dir: 'desc' });
  });
  it('preserves the chosen direction for other sorts while returning to page one', () => {
    const state = urlState('page=3&sort=fit_score&dir=asc');
    state.render().setValues(listingSortPatch('price'));
    expect(state.render().values).toEqual({ page: 1, sort: 'price', dir: 'asc' });
  });
  it('retains the JEV field when its direction is reversed and shared', () => {
    const state = urlState('page=2&sort=fit_score');
    state.render().setValues({ dir: 'asc', page: 1 });
    expect(urlState(state.url()).render().values).toEqual({ page: 1, sort: 'fit_score', dir: 'asc' });
  });
});
