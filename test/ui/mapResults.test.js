/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({
  useLocale: () => 'en',
  useTranslation: () => (key, params) => `${key}${params ? JSON.stringify(params) : ''}`,
}));
vi.mock('../../ui/src/components/searchWorkspace/FitSummary.jsx', () => ({ default: function FitSummary() {} }));
vi.mock('../../ui/src/components/listings/ListingPhoto.jsx', () => ({ default: function ListingPhoto() {} }));
import MapResults from '../../ui/src/views/listings/components/MapResults.jsx';

function findAll(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (node == null || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
const listing = {
  id: 'one',
  title: '<script>Portal title</script>',
  price: 1200,
  size: 80,
  rooms: 3,
  address: 'Berlin',
  fitSummary: { score: 90 },
};
const nodes = (tree, type) => findAll(tree, (node) => node.type === type);

describe('map result cards', () => {
  it('shows exactly the supplied adverts, with accessible detail and locate actions', () => {
    const locate = vi.fn();
    const highlight = vi.fn();
    const tree = MapResults({ listings: [listing], selectedId: 'one', onLocate: locate, onHighlight: highlight });
    expect(nodes(tree, 'article')).toHaveLength(1);
    const card = nodes(tree, 'article')[0];
    expect(card.props.className).toContain('--selected');
    card.props.onMouseEnter();
    expect(highlight).toHaveBeenLastCalledWith('one');
    card.props.onMouseLeave();
    expect(highlight).toHaveBeenLastCalledWith(null);
    for (const button of nodes(tree, 'button')) button.props.onClick();
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate).toHaveBeenLastCalledWith('one');
    const link = findAll(tree, (node) => node.props?.to)[0];
    expect(link.props.to).toBe('/listings/listing/one');
    expect(link.props.children).toBe(listing.title);
  });
  it('distinguishes loading from a viewport with no results', () => {
    const props = { listings: [], selectedId: null, onLocate: vi.fn(), onHighlight: vi.fn() };
    const loading = MapResults({ ...props, loading: true });
    expect(loading.props['aria-busy']).toBe(true);
    expect(findAll(loading, (node) => node.props?.className === 'map-results__empty')).toHaveLength(0);
    const empty = MapResults(props);
    expect(empty.props['aria-busy']).toBe(false);
    expect(findAll(empty, (node) => node.props?.className === 'map-results__empty')).toHaveLength(1);
    expect(nodes(empty, 'article')).toHaveLength(0);
  });
});
