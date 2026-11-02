/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Refresh location evidence for existing visible listings without rescraping, notifying or
 * changing their notes/application/activity. Run from the application root; dry-run by default.
 * Pass --apply to persist coordinates and recheck every stored listing against its current job.
 */
import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { readLocation } from '../../lib/services/immoscout/mobileApi.js';
import { geocode } from '../../lib/services/geocoding/client/nominatimClient.js';
import { isSwapOffer, excludesSwapOffers } from '../../lib/services/listings/searchEligibility.js';
import { recheckSearchEligibility } from '../../lib/services/storage/searchEligibilityStorage.js';
import { updateListingGeocoordinates } from '../../lib/services/storage/listingsStorage.js';
import { getCountriesForListing } from '../../lib/services/providers/providerCountries.js';

const print = (value) => process.stdout.write(`${value}\n`);
await SqliteConnection.init();
const apply = process.argv.includes('--apply');
const db = SqliteConnection.getConnection();
const rows = db
  .prepare(`SELECT l.*, j.provider AS sources, j.spatial_filter FROM listings l JOIN jobs j ON j.id = l.job_id
  WHERE l.manually_deleted = 0 AND j.spatial_filter IS NOT NULL ORDER BY l.id`)
  .all();
const counts = { checked: 0, precise: 0, uncertain: 0, swaps: 0, failures: 0 };
for (const row of rows) {
  if (excludesSwapOffers({ provider: row.sources }) && isSwapOffer(row)) {
    counts.swaps++;
    continue;
  }
  if (row.address_is_manual) {
    counts.checked++;
    continue;
  }
  let position = { latitude: row.latitude, longitude: row.longitude, locationSource: 'approximate' };
  try {
    if (['immoscout', 'immoscoutAt'].includes(row.provider)) {
      const id = /^https:\/\/www\.immobilienscout24\.de\/expose\/(\d+)\/?$/.exec(row.link ?? '')?.[1];
      if (id) {
        const response = await fetch(`https://api.mobile.immobilienscout24.de/expose/${id}`, {
          headers: { 'User-Agent': 'ImmoScout_27.3_26.0_._' },
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 429) throw new Error('rate_limited');
        if (response.ok) position = { ...position, ...readLocation(await response.json()) };
        else counts.failures++;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } else if (row.address) {
      // Bypass the listing cache deliberately: its old district centroids are what needs review.
      const point = await geocode(row.address, await getCountriesForListing(row.provider, row));
      if (point && point.lat !== -1 && point.lng !== -1)
        position = { latitude: point.lat, longitude: point.lng, locationSource: point.locationSource };
    }
  } catch (error) {
    counts.failures++;
    if (error.message === 'rate_limited') {
      print(JSON.stringify({ ...counts, stopped: 'rate_limited' }));
      break;
    }
  }
  if (apply) updateListingGeocoordinates(row.id, position.latitude, position.longitude, position.locationSource);
  counts.checked++;
  counts[['portal', 'geocoded_house', 'manual'].includes(position.locationSource) ? 'precise' : 'uncertain']++;
  if (counts.checked % 20 === 0) print(JSON.stringify(counts));
}
if (apply) print(JSON.stringify({ apply, ...counts, eligibility: recheckSearchEligibility() }));
else print(JSON.stringify({ apply, ...counts }));
SqliteConnection.close();
