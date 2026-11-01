/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { formatDecimal } from '../number/numberService.js';
import { formatEuroPrice } from '../price/priceService.js';

/** Supported topic icons, also offered by the requirements editor. */
export const CRITERION_ICONS = [
  'rooms',
  'size',
  'budget',
  'transit',
  'kitchen',
  'pets',
  'outdoor',
  'lift',
  'lease',
  'furniture',
  'requirement',
];

// These identify a topic, never infer a verdict or rewrite what the requirement means.
const TOPICS = [
  ['rooms', 'bedrooms', /\b(bedrooms?|schlafzimmer)\b/i],
  ['kitchen', 'kitchen', /\b(kitchen|küche|kueche|einbauküche|einbaukueche)\b/i],
  ['pets', 'pets', /\b(pets?|dogs?|cats?|haustiere?|hunde?|katzen?|tierhaltung)\b/i],
  ['outdoor', 'outdoor', /\b(balcony|balconies|terrace|garden|balkon|terrasse|garten)\b/i],
  ['lift', 'lift', /\b(lift|elevator|aufzug|fahrstuhl)\b/i],
  ['lease', 'lease', /\b(lease|long[- ]term|short[- ]term|unbefristet\w*|befristet\w*|mietdauer|mietvertrag)\b/i],
  ['furniture', 'furniture', /\b(furnish\w*|unfurnish\w*|möbliert\w*|unmöbliert\w*|moebliert\w*|unmoebliert\w*)\b/i],
  ['budget', 'budgetTopic', /\b(budget|rent|price|miete|warmmiete|kaltmiete|preis|nebenkosten)\b/i],
  ['rooms', 'roomsTopic', /\b(rooms?|zimmer)\b/i],
  ['size', 'sizeTopic', /\b(size|space|fläche|flaeche|wohnfläche|wohnflaeche)\b|m²|sqm/i],
  ['transit', 'transitTopic', /\b(metro|subway|transit|station|u-bahn|s-bahn|haltestelle|bahnhof)\b/i],
];

/**
 * A short topic label for scanning; the original requirement remains the source of meaning.
 * Structured criteria retain their actual threshold. Legacy semantic criteria receive a localized
 * topic, while unsupported wording uses a numbered fallback rather than a guessed summary.
 * @param {object} criterion Saved criterion; may carry an optional short label and topic icon.
 * @param {{t: Function, locale?: string, index?: number}} options Display context; index is zero-based.
 * @returns {{label: string, icon: string}}
 */
export function criterionPresentation(criterion, { t, locale = 'en', index = 0 }) {
  let icon = 'requirement';
  let label = t('search.chip.requirement', { number: index + 1 });
  if (['min_rooms', 'min_size', 'max_price'].includes(criterion.kind) && Number.isFinite(criterion.value)) {
    icon = { min_rooms: 'rooms', min_size: 'size', max_price: 'budget' }[criterion.kind];
    label = t(`search.chip.${icon}`, {
      value: icon === 'budget' ? formatEuroPrice(criterion.value, locale) : formatDecimal(criterion.value, locale),
    });
  } else if (criterion.kind === 'station_line' && criterion.line && Number.isFinite(criterion.maxWalkMinutes)) {
    icon = 'transit';
    label = t(criterion.line === '*' ? 'search.chip.anyTransit' : 'search.chip.transit', {
      line: criterion.line,
      minutes: criterion.maxWalkMinutes,
    });
  } else {
    const topic = TOPICS.find(([, , pattern]) => pattern.test(criterion.text ?? ''));
    if (topic) {
      icon = topic[0];
      label = t(`search.chip.${topic[1]}`);
    }
  }
  if (typeof criterion.label === 'string' && criterion.label.trim() && criterion.label.trim().length <= 32)
    label = criterion.label.trim();
  if (CRITERION_ICONS.includes(criterion.icon)) icon = criterion.icon;
  return { label, icon };
}
