/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({ default: vi.fn() }));
vi.mock('../../lib/services/logger.js', () => ({ default: { warn: vi.fn() } }));

import puppeteerExtractor from '../../lib/services/extractor/puppeteerExtractor.js';
import { config } from '../../lib/provider/ohneMakler.js';

const html = await readFile(
  new URL('../testFixtures/ohneMakler-search-enhancement-detail.html', import.meta.url),
  'utf8',
);
const card = () =>
  config.normalize({
    title: 'Wohnung mit zwei Schlafzimmern',
    link: '/immobilie/12345/',
    price: '1.800 €',
    size: '92 m²',
    rooms: '3',
    address: '10115 Berlin',
    image: 'https://images.example.org/card.jpg',
  });

describe('OhneMakler detail evidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds narrative and labelled facts while preserving search identity and cold rent', async () => {
    puppeteerExtractor.mockResolvedValue(html);
    const listing = card();
    const enriched = await config.fetchDetails(listing, { id: 'shared-browser' });
    expect(enriched).toMatchObject({
      id: listing.id,
      link: listing.link,
      price: 1800,
      size: 92,
      rooms: 3,
      charges: 350,
      chargesIncluded: false,
      buildYear: 2019,
      energyClass: 'B',
    });
    for (const evidence of [
      'unbefristet',
      'Hunde sind erlaubt',
      'Zwei separate Schlafzimmer',
      'Schlafzimmer (Anzahl): 2',
      'Stockwerk: 4. OG',
      'Heizkosten: 150 €',
      '2.150 € monatlich',
    ]) {
      expect(enriched.description).toContain(evidence);
    }
    expect(enriched.description).not.toContain('Haustiere verboten');
    expect(enriched.images).toHaveLength(2);
    expect(enriched.images.some((image) => image.caption === 'Grundriss')).toBe(true);
    expect(puppeteerExtractor).toHaveBeenCalledWith(listing.link, null, {
      browser: { id: 'shared-browser' },
      name: 'ohneMakler_details',
    });
    expect(listing.description).toBeUndefined();
  });

  it('keeps a card unchanged when the page is a different advert or a bot/error page', async () => {
    const listing = card();
    puppeteerExtractor
      .mockResolvedValueOnce(html.replace('OM-12345', 'OM-54321'))
      .mockResolvedValueOnce('<h1>Verify your browser</h1>');
    expect(await config.fetchDetails(listing)).toBe(listing);
    expect(await config.fetchDetails(listing)).toBe(listing);
  });

  it('does not label a different headline amount as cold rent', async () => {
    puppeteerExtractor.mockResolvedValue(html);
    const listing = { ...card(), price: 2150 };
    const enriched = await config.fetchDetails(listing);
    expect(enriched.price).toBe(2150);
    expect(enriched.chargesIncluded).toBeUndefined();
    expect(enriched.description).toContain('Kaltmiete: 1.800 €');
  });

  it('does not invent missing charges, energy ratings or narrative', async () => {
    const listing = { ...card(), description: 'Saved description' };
    puppeteerExtractor.mockResolvedValue('<table><tr><td>Objekt-Nr</td><td>OM-12345</td></tr></table>');
    const enriched = await config.fetchDetails(listing);
    expect(enriched.description).toBe('Saved description');
    expect(enriched.charges).toBeUndefined();
    expect(enriched.chargesIncluded).toBeUndefined();
    expect(enriched.energyClass).toBeUndefined();
  });

  it('keeps stored card data on unavailable pages or network failure', async () => {
    const listing = card();
    puppeteerExtractor.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Unavailable'));
    expect(await config.fetchDetails(listing)).toBe(listing);
    expect(await config.fetchDetails(listing)).toBe(listing);
  });

  it('refuses off-provider links and non-advert paths without a request', async () => {
    for (const link of [
      'https://example.org/immobilie/12345/',
      'http://www.ohne-makler.net/immobilie/12345/',
      'https://www.ohne-makler.net/immobilien/wohnung-mieten/berlin/',
      'https://user@www.ohne-makler.net/immobilie/12345/',
    ]) {
      const listing = { ...card(), link };
      expect(await config.fetchDetails(listing)).toBe(listing);
    }
    expect(puppeteerExtractor).not.toHaveBeenCalled();
  });
});
