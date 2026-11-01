/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { isOneOf, buildHash } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import * as cheerio from 'cheerio';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import { extractBuildingFacts, normalizeBuildYear, normalizeEnergyClass } from '../utils/buildingFacts.js';
import { toListingImages } from '../utils/listingImages.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const link = metaInformation.baseUrl + o.link;
  const id = buildHash(o.title, o.link, o.price);
  return {
    id,
    link,
    title: o.title || '',
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: o.image,
    description: o.description,
  };
}
/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList Terms the job wants filtered out.
 * @returns {boolean}
 */
function applyBlacklist(o, appliedBlackList) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return titleNotBlacklisted && descNotBlacklisted;
}

/** Collapse a portal label/value to plain text without carrying markup into listing evidence. */
const plainText = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Enrich the normalized search card with the advert's own text, labelled costs and gallery.
 *
 * Search cards carry no description. Keep the headline price, hash and canonical search link:
 * replacing them with the exposé's warm rent would make the next search see a different advert.
 * A matching Objekt-Nr binds the response to this listing; an error page or another ad is ignored.
 * Missing facts stay missing, and labelled rent components are retained verbatim as evidence so
 * the evaluator never has to infer that a displayed Kaltmiete includes heating.
 *
 * @param {ParsedListing} listing The unchanged search-card identity to enrich.
 * @param {import('../types/browser.js').Browser} [browser] The job's existing browser.
 * @returns {Promise<ParsedListing>} The enriched listing, or the original on an unavailable page.
 */
async function fetchDetails(listing, browser) {
  let url;
  try {
    url = new URL(listing.link);
  } catch {
    return listing;
  }
  const id = /^\/immobilie\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (
    !id ||
    url.protocol !== 'https:' ||
    !['www.ohne-makler.net', 'ohne-makler.net'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    return listing;

  try {
    const html = await puppeteerExtractor(url.href, null, { browser, name: 'ohneMakler_details' });
    if (!html) return listing;
    const $ = cheerio.load(html);
    const facts = new Map();
    $('table tr').each((_, row) => {
      const cells = $(row).children('td');
      if (cells.length !== 2) return;
      const label = plainText(cells.eq(0).text());
      const value = plainText(cells.eq(1).text());
      if (label && value) facts.set(label, value);
    });
    const objectNumber = facts.get('Objekt-Nr') ?? facts.get('Objekt-Nr.');
    if (objectNumber !== `OM-${id}`) return listing;

    const paragraphs = [];
    $('#beschreibung .prose, #ausstattung .prose, #ort .prose, #sonstiges .prose').each((_, element) => {
      const content = $(element).clone();
      content.find('script, style, template').remove();
      content.find('br').replaceWith('\n');
      content.find('p').each((_, paragraph) => $(paragraph).append('\n'));
      const text = content.text().split('\n').map(plainText).filter(Boolean).join('\n');
      if (text) paragraphs.push(text);
    });
    const labelledFacts = [...facts].filter(([label]) => !/^Objekt-Nr\.?$/.test(label));
    const description = [...paragraphs, ...labelledFacts.map(([label, value]) => `${label}: ${value}`)]
      .join('\n\n')
      .slice(0, 20000);
    const building = extractBuildingFacts(description);
    const images = toListingImages(
      $('a[data-glightbox]')
        .toArray()
        .map((element) => ({
          url: $(element).attr('href'),
          caption: plainText(
            $(element)
              .attr('data-glightbox')
              ?.match(/description:\s*(.*)$/)?.[1],
          ),
        })),
    );
    const charges = extractNumber(facts.get('Summe Nebenkosten/Heizkosten'));
    // An advert may state both cold and warm rent. A cold-rent row only labels the retained
    // card price when its value actually matches; a different figure stays unknown.
    const coldRent = extractNumber(facts.get('Kaltmiete'));

    return {
      ...listing,
      description: description || listing.description,
      buildYear: normalizeBuildYear(facts.get('Baujahr')) ?? building.buildYear ?? listing.buildYear,
      energyClass:
        normalizeEnergyClass(facts.get('Energieeffizienzklasse')) ?? building.energyClass ?? listing.energyClass,
      ...(Number.isFinite(charges) ? { charges } : {}),
      ...(Number.isFinite(coldRent) && coldRent === listing.price ? { chargesIncluded: false } : {}),
      ...(images.length ? { images } : {}),
    };
  } catch {
    logger.warn(`Could not fetch OhneMakler detail page for listing '${listing.id}'.`);
    return listing;
  }
}
/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlContainer: 'div[data-livecomponent-id*="search/property_list"] .grid > div',
  sortByDateParam: null,
  // ?price_min=500&price_max=1000
  priceRangeParams: { min: 'price_min', max: 'price_max' },
  waitForSelector: null,
  crawlFields: {
    id: 'a@href',
    title: 'h4 | removeNewline | trim',
    price: '.text-xl | trim',
    size: 'div[title="Wohnfläche"] | trim',
    rooms: 'div[title="Zimmer"] | trim',
    address: '.text-slate-800 | removeNewline | trim',
    image: 'img@src',
    link: 'a@href',
  },
  normalize: normalize,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
};

/**
 * Build a run-scoped provider configuration.
 *
 * Returns a fresh object on every call instead of mutating module-level state. Two jobs can be in
 * flight at once - a manual run started while the scheduler is working through the others - and a
 * shared mutable config meant the second job overwrote the first job's URL and blacklist mid-run,
 * so listings were fetched for one job and stored under another.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig The job's entry for this provider.
 * @param {string[]} [blacklist] Terms to filter listings out by.
 * @returns {ProviderConfig} A configuration usable by a single pipeline run.
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export const metaInformation = {
  countries: ['de'],
  name: 'OhneMakler',
  baseUrl: 'https://www.ohne-makler.net',
  id: 'ohneMakler',
};
export { config };
