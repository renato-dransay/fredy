/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createHash } from 'node:crypto';
import { evaluateSemantic, JEV_MODEL } from './jev.js';
import { DEFAULT_JEV_INSTRUCTIONS } from './instructions.js';
import { evaluateStationLine } from './stationLine.js';

/** Canonicalize normalized provider fields and stored columns without inventing their meaning. */
function rentAndEnergyEvidence(listing) {
  const included = listing.charges_included ?? listing.chargesIncluded;
  return {
    charges_included: included === true || included === 1 ? true : included === false || included === 0 ? false : null,
    charges: Number.isFinite(listing.charges) && listing.charges >= 0 ? listing.charges : null,
    energy_class: listing.energy_class ?? listing.energyClass ?? null,
  };
}

/** Only source fields used by the evaluator enter the snapshot: changing notes is not new apartment evidence. */
export function listingEvidence(listing) {
  return {
    ...Object.fromEntries(
      ['title', 'description', 'address', 'price', 'size', 'rooms', 'latitude', 'longitude', 'link', 'provider'].map(
        (key) => [key, listing[key] ?? null],
      ),
    ),
    ...rentAndEnergyEvidence(listing),
  };
}

/** Bind evaluation to the preferences, observed listing, model and local scoring rules. */
export function fitEvidenceHash(profile, listing) {
  // Default guidance preserves pre-configuration receipts; a custom instruction is evidence
  // context and must invalidate them. Migration alone must not enqueue new paid assessments.
  const { instructions, ...preferences } = profile;
  if (instructions && instructions !== DEFAULT_JEV_INSTRUCTIONS) preferences.instructions = instructions;
  return createHash('sha256')
    .update(JSON.stringify({ rubric: 2, model: JEV_MODEL, profile: preferences, listing: listingEvidence(listing) }))
    .digest('hex');
}

/** Existing-source excerpts, each a finite choice Jev may cite without generating text. */
export function sourcesForListing(listing) {
  const sources = [];
  for (const key of ['title', 'address', 'rooms', 'size', 'price']) {
    if (listing[key] != null && String(listing[key]).trim())
      sources.push({ source: `listing.${key}`, text: String(listing[key]).slice(0, 1000) });
  }
  const facts = rentAndEnergyEvidence(listing);
  if (facts.charges_included != null) {
    sources.push({
      source: 'listing.charges_included',
      text: `The quoted price ${facts.charges_included ? 'includes' : 'excludes'} the stated running charges. This does not establish whether heating is included.`,
    });
  }
  if (facts.charges != null) {
    sources.push({
      source: 'listing.charges',
      text: `Stated monthly running charges: ${facts.charges}. These may already be included in the price; their scope and heating inclusion require explicit listing evidence. Do not assume a complete Warmmiete from this amount.`,
    });
  }
  if (facts.energy_class != null && String(facts.energy_class).trim()) {
    sources.push({
      source: 'listing.energy_class',
      text: `Energy efficiency class: ${String(facts.energy_class).slice(0, 50)}.`,
    });
  }
  const description = String(listing.description ?? '').slice(0, 20000);
  // Additional structured evidence must not push the end of an otherwise bounded description
  // out of the source budget: lease terms and pet restrictions often appear at its end.
  const chunkSize = Math.max(800, Math.ceil(description.length / (30 - sources.length)));
  let offset = 0;
  while (offset < description.length && sources.length < 30) {
    const text = description.slice(offset, offset + chunkSize);
    sources.push({ source: `listing.description:${offset}`, text });
    offset += chunkSize;
  }
  return sources;
}

/** The conservative score includes unknown requirements as zero; coverage explains that uncertainty. */
export function summarizeFit(criteria) {
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const matched = criteria
    .filter((criterion) => criterion.verdict === 'met')
    .reduce((sum, criterion) => sum + criterion.weight, 0);
  const known = criteria
    .filter((criterion) => criterion.verdict !== 'unknown')
    .reduce((sum, criterion) => sum + criterion.weight, 0);
  return {
    score: total ? Math.round((100 * matched) / total) : 0,
    coverage: total ? Math.round((100 * known) / total) : 0,
    hardFailure: criteria.some((criterion) => criterion.required && criterion.verdict === 'unmet'),
    hardUnknown: criteria.some((criterion) => criterion.required && criterion.verdict === 'unknown'),
  };
}

/** Numeric specifications use actual normalized fields; rooms do not establish a bedroom count. */
export function evaluateNumeric(criterion, listing) {
  const field = { min_rooms: 'rooms', min_size: 'size', max_price: 'price' }[criterion.kind];
  const actual = listing[field];
  if (!Number.isFinite(actual) || actual <= 0) return { verdict: 'unknown', confidence: 0, evidence: [] };
  const met = criterion.kind === 'max_price' ? actual <= criterion.value : actual >= criterion.value;
  return {
    verdict: met ? 'met' : 'unmet',
    confidence: 1,
    evidence: [{ source: `listing.${field}`, text: `${field}: ${actual}; ${criterion.kind}: ${criterion.value}.` }],
  };
}

/** Evaluate an immutable profile/listing snapshot; callers own access checks and persistence. */
export async function evaluateFit(
  profile,
  listing,
  { semantic = evaluateSemantic, station = evaluateStationLine } = {},
) {
  const signal = AbortSignal.timeout(75000);
  const semanticCriteria = profile.criteria.filter((criterion) => criterion.kind === 'semantic');
  const semanticAnswer = await semantic(semanticCriteria, sourcesForListing(listing), {
    instructions: profile.instructions,
  });
  const byId = new Map(semanticAnswer.results.map((result) => [result.id, result]));
  const criteria = [];
  for (const criterion of profile.criteria) {
    signal.throwIfAborted();
    let answer;
    if (criterion.kind === 'semantic') answer = byId.get(criterion.id);
    else if (criterion.kind === 'station_line') answer = await station(criterion, listing, { signal });
    else answer = evaluateNumeric(criterion, listing);
    criteria.push({ ...criterion, ...answer });
  }
  return {
    ...summarizeFit(criteria),
    criteria,
    profileVersion: profile.version,
    evidenceHash: fitEvidenceHash(profile, listing),
    evaluatedAt: new Date().toISOString(),
    semanticEvaluatedAt: semanticAnswer.evaluatedAt || new Date().toISOString(),
    model: semanticAnswer.model,
  };
}

/** Old source snapshots and dated transit assessments are shown as stale, never silently current. */
export function isFitStale(result, profile, listing, now = Date.now()) {
  return (
    !!result &&
    (result.evidenceHash !== fitEvidenceHash(profile, listing) ||
      !Number.isFinite(Date.parse(result.evaluatedAt)) ||
      now - Date.parse(result.semanticEvaluatedAt || result.evaluatedAt) > 86400000 ||
      now - Date.parse(result.evaluatedAt) >
        (result.criteria?.some((criterion) => criterion.kind === 'station_line' && criterion.verdict === 'unknown')
          ? 60000
          : 86400000))
  );
}
