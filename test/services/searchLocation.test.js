/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { describe, it, expect } from 'vitest';
import { readLocation } from '../../lib/services/immoscout/mobileApi.js';
import { geocodeLocationSource } from '../../lib/services/geocoding/client/nominatimClient.js';
describe('location evidence', () => {
  it('keeps an actual ImmoScout street position and does not promote a hidden street', () => {
    const map = { type: 'MAP', location: { lat: 52.53, lng: 13.36 }, addressLine1: 'Example Straße 24' };
    expect(readLocation({ sections: [map] })).toEqual({ latitude: 52.53, longitude: 13.36, locationSource: 'portal' });
    expect(
      readLocation({ sections: [{ ...map, addressLine1: 'Die vollständige Adresse erhältst du vom Anbieter' }] })
        .locationSource,
    ).toBe('approximate');
    expect(readLocation({ sections: [{ type: 'MAP', zipCodeShapes: [] }] })).toEqual({ locationSource: 'approximate' });
  });
  it('requires matching house and street evidence from the geocoder', () => {
    const result = { addresstype: 'house', address: { house_number: '24', road: 'Example Straße' } };
    expect(geocodeLocationSource('Example Straße 24, Berlin', result)).toBe('geocoded_house');
    expect(geocodeLocationSource('Example Straße 25, Berlin', result)).toBe('approximate');
    expect(geocodeLocationSource('Other Straße 24, Berlin', result)).toBe('approximate');
    expect(geocodeLocationSource('1024 Berlin', result)).toBe('approximate');
    expect(geocodeLocationSource('Berlin', { addresstype: 'city' })).toBe('approximate');
  });
});
