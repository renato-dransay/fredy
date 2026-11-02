/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

/** Read persisted JSON or an already hydrated job field without widening malformed areas. */
function json(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** A source's explicit no-swap preference applies to the entire job, across every portal. */
export function excludesSwapOffers(job) {
  const sources = json(job.provider, []);
  return (
    Array.isArray(sources) &&
    sources.some((source) => {
      try {
        const url = new URL(source.url);
        return (
          /(^|\.)immobilienscout24\.(de|at)$/.test(url.hostname) &&
          url.searchParams
            .getAll('exclusioncriteria')
            .some((value) => value.toLowerCase().split(',').includes('swapflat'))
        );
      } catch {
        return false;
      }
    })
  );
}

/** Detect exchange-only advertising, while allowing an explicit statement that no swap is needed. */
export function isSwapOffer(listing) {
  const text = `${listing.title ?? ''}\n${listing.description ?? ''}`;
  return text.split(/[.!?\n]+/).some((sentence) => {
    const match =
      /\b(?:tauschwohnung|wohnungstausch|tausch\s*(?:angebot|objekt)|nur\s+(?:im\s+)?tausch|ausschlie[ßs]+lich\s+(?:im\s+)?tausch|swap\s*(?:flat|apartment)|apartment\s+swap|swap\s+only|exchange\s+only)\b/i.exec(
        sentence,
      );
    if (
      match &&
      /^\s+(?:(?:ist|is)\s+)?(?:nicht|not)\s+(?:erforderlich|nötig|notwendig|möglich|required|needed)/i.test(
        sentence.slice(match.index + match[0].length),
      )
    )
      return false;
    return (
      match != null &&
      !/\b(?:kein(?:e[rmns]?)?|ohne|nicht|no|not)\s+(?:[\p{L}-]+\s+){0,2}$/iu.test(sentence.slice(0, match.index))
    );
  });
}

/** A finite geographic point, excluding the legacy not-found sentinel. */
export function hasLocation(listing) {
  return (
    Number.isFinite(listing.latitude) &&
    Number.isFinite(listing.longitude) &&
    Math.abs(listing.latitude) <= 90 &&
    Math.abs(listing.longitude) <= 180 &&
    !(listing.latitude === -1 && listing.longitude === -1)
  );
}

/**
 * Classify against the current job, independently of source, activity, fit score or user deletion.
 * A district centroid is not evidence for either acceptance or exclusion. Only an explicit
 * portal street position, a geocoded house, or a manually confirmed point may decide the area.
 * @param {object} listing Stored or normalized listing.
 * @param {object} job Current persisted or hydrated job.
 * @returns {{state: 'match'|'review'|'excluded', reason: string|null}}
 */
export function searchEligibility(listing, job) {
  if (excludesSwapOffers(job) && isSwapOffer(listing)) return { state: 'excluded', reason: 'swap' };
  const rawArea = job.spatial_filter ?? job.spatialFilter;
  if (rawArea == null) return { state: 'match', reason: null };
  const area = json(rawArea, null);
  if (!Array.isArray(area?.features)) return { state: 'review', reason: 'invalid_area' };
  const polygons = area.features.filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type));
  if (!polygons?.length) return { state: 'review', reason: 'invalid_area' };
  const source = listing.location_source ?? listing.locationSource;
  if (!hasLocation(listing) || !['portal', 'geocoded_house', 'manual'].includes(source)) {
    return { state: 'review', reason: 'uncertain_location' };
  }
  try {
    return polygons.some((feature) => booleanPointInPolygon([listing.longitude, listing.latitude], feature))
      ? { state: 'match', reason: null }
      : { state: 'excluded', reason: 'outside_area' };
  } catch {
    return { state: 'review', reason: 'invalid_area' };
  }
}
