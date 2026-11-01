/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const KINDS = new Set(['semantic', 'min_rooms', 'min_size', 'max_price', 'station_line']);
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validate and normalize only the supported apartment requirement fields. */
export function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('A requirements profile is required.');
  const instructions = input.instructions ?? '';
  if (typeof instructions !== 'string' || instructions.length > 4000)
    throw new Error('JEV instructions must be text, at most 4000 characters.');
  const document = input.document ?? '';
  if (typeof document !== 'string' || Buffer.byteLength(document) > 32768) {
    throw new Error('The requirements document must be text or Markdown, at most 32 KB.');
  }
  if (!Array.isArray(input.criteria) || input.criteria.length > 30) throw new Error('Use at most 30 requirements.');
  const ids = new Set();
  const criteria = input.criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion))
      throw new Error('Invalid requirement.');
    const id = criterion.id ?? `criterion-${index + 1}`;
    const text = typeof criterion.text === 'string' ? criterion.text.trim() : '';
    const kind = criterion.kind ?? 'semantic';
    const weight = criterion.weight ?? 1;
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id))
      throw new Error('Requirement IDs must be unique letters, numbers, hyphens or underscores.');
    ids.add(id);
    if (text.length < 1 || text.length > 1000) throw new Error('Each requirement needs between 1 and 1000 characters.');
    if (!KINDS.has(kind)) throw new Error('Unknown requirement type.');
    if (!Number.isInteger(weight) || weight < 1 || weight > 10)
      throw new Error('Requirement weights must be integers from 1 to 10.');
    if (criterion.required != null && typeof criterion.required !== 'boolean')
      throw new Error('Must-have must be a boolean.');
    const normalized = { id, text, kind, required: criterion.required === true, weight };
    if (criterion.label != null) {
      if (typeof criterion.label !== 'string' || criterion.label.trim().length > 32)
        throw new Error('Use a short label of at most 32 characters.');
      if (criterion.label.trim()) normalized.label = criterion.label.trim();
    }
    if (criterion.icon != null && criterion.icon !== '') {
      if (
        ![
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
        ].includes(criterion.icon)
      )
        throw new Error('Unknown requirement icon.');
      normalized.icon = criterion.icon;
    }
    if (['min_rooms', 'min_size', 'max_price'].includes(kind)) {
      if (!Number.isFinite(criterion.value) || criterion.value <= 0 || criterion.value > 100000000) {
        throw new Error('Numeric requirements need a positive finite value.');
      }
      normalized.value = criterion.value;
    }
    if (kind === 'station_line') {
      const line = typeof criterion.line === 'string' ? criterion.line.trim().toUpperCase() : '';
      if (line !== '*' && !/^[A-Z0-9][A-Z0-9 -]{0,15}$/.test(line))
        throw new Error('Station line must be a short line name, for example U2, or * for any U-Bahn line.');
      if (
        !Number.isInteger(criterion.maxWalkMinutes) ||
        criterion.maxWalkMinutes < 1 ||
        criterion.maxWalkMinutes > 60
      ) {
        throw new Error('Walking limits must be whole minutes from 1 to 60.');
      }
      normalized.line = line;
      normalized.maxWalkMinutes = criterion.maxWalkMinutes;
    }
    return normalized;
  });
  return { document, criteria, instructions: instructions.trim() };
}
