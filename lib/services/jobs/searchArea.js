/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { toPolyline } from '../immoscout/shape.js';

/**
 * Convert ImmoScout's existing drawn search area to a closed GeoJSON polygon at precision 5.
 * Reject malformed/oversized polylines rather than silently widening the search. Coordinate
 * pairs in the source are latitude,longitude; GeoJSON explicitly reverses them.
 * @param {string} searchUrl
 * @returns {object} A GeoJSON FeatureCollection suitable for a job's spatialFilter.
 */
export function searchAreaFromImmoScout(searchUrl) {
  const url = new URL(searchUrl);
  if (!['www.immobilienscout24.de', 'immobilienscout24.de'].includes(url.hostname))
    throw new Error('Use an ImmoScout search URL.');
  const encoded = url.searchParams.get('shape');
  if (!encoded) throw new Error('This search has no drawn area.');
  const polyline = toPolyline(encoded);
  if (polyline.length > 50000) throw new Error('The drawn area is too large.');
  let offset = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];
  const delta = () => {
    let number = 0;
    let shift = 0;
    let digit;
    do {
      if (offset >= polyline.length || shift > 30) throw new Error('Invalid drawn area.');
      digit = polyline.charCodeAt(offset++) - 63;
      if (digit < 0 || digit > 63) throw new Error('Invalid drawn area.');
      number += (digit & 31) * 2 ** shift;
      shift += 5;
    } while (digit >= 32);
    return number % 2 ? -(number + 1) / 2 : number / 2;
  };
  while (offset < polyline.length) {
    lat += delta();
    lng += delta();
    if (Math.abs(lat) > 90e5 || Math.abs(lng) > 180e5 || coordinates.length >= 5000)
      throw new Error('Invalid drawn area coordinates.');
    coordinates.push([lng / 1e5, lat / 1e5]);
  }
  if (new Set(coordinates.map(String)).size < 3) throw new Error('A drawn area needs at least three points.');
  if (String(coordinates[0]) !== String(coordinates.at(-1))) coordinates.push([...coordinates[0]]);
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } }],
  };
}
