/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Shared fit tone for cards and pins, on the same rounded display scale. Missing scores are
 * unassessed; required failures override scores, and stale/unknown results never appear green.
 * @param {{score: number, hardFailure?: boolean, hardUnknown?: boolean, stale?: boolean}|null} summary
 * @returns {'unassessed'|'low'|'medium'|'high'}
 */
export function fitTone(summary) {
  if (!summary || !Number.isFinite(summary.score)) return 'unassessed';
  const score = Math.round(Math.max(0, Math.min(100, summary.score))) / 10;
  return summary.hardFailure || score < 5
    ? 'low'
    : summary.stale || summary.hardUnknown || score < 8
      ? 'medium'
      : 'high';
}

/** Minimum-fit choices on the displayed ten-point scale. */
export const MIN_FIT_OPTIONS = Array.from({ length: 11 }, (_, index) => index);

/**
 * Validate a displayed fit floor without treating missing values as a zero score.
 * @param {number|null} value Ten-point floor.
 * @returns {number|null} Percentage floor matching the saved score scale.
 */
export function minFitPercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value * 10 : null;
}

/** URL codec shared by both pages; empty and invalid bookmarks leave the filter off. */
export const minFitCodec = {
  parse: (raw) => {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return minFitPercentage(value) == null ? null : value;
  },
  stringify: (value) => (minFitPercentage(value) == null ? null : String(value)),
};

/**
 * Filter saved current-user receipts. A floor of zero still requires an assessment.
 * @param {Object[]} listings
 * @param {number|null} minimum Ten-point floor.
 * @returns {Object[]}
 */
export function filterByMinFit(listings, minimum) {
  const floor = minFitPercentage(minimum);
  return floor == null
    ? listings
    : listings.filter((listing) => Number.isFinite(listing.fitSummary?.score) && listing.fitSummary.score >= floor);
}

/**
 * Sort viewport results after position grouping, matching the overview's saved-score order.
 * Missing assessments are last in either direction; date/id break ties. Never mutates store rows.
 * @param {Object[]} listings
 * @param {'asc'|'desc'|null} direction Null preserves the map's original ordering.
 * @returns {Object[]}
 */
export function sortByFit(listings, direction) {
  if (direction !== 'asc' && direction !== 'desc') return listings;
  const score = (listing) => (Number.isFinite(listing.fitSummary?.score) ? listing.fitSummary.score : null);
  return [...listings].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    if ((left == null) !== (right == null)) return left == null ? 1 : -1;
    if (left != null && right != null && left !== right) return (left - right) * (direction === 'asc' ? 1 : -1);
    const date = (b.published_at ?? b.created_at ?? 0) - (a.published_at ?? a.created_at ?? 0);
    return date || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
