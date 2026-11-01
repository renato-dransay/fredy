/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { evaluateFit, fitEvidenceHash, isFitStale } from './evaluate.js';
import { getFitProfile, getFitResult, saveFitResult } from './storage.js';

const inFlight = new Map();

/** A safe error shared by HTTP and automatic callers; no source/profile text is exposed. */
export class FitEvaluationError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Assess one user's accessible listing, coalescing concurrent manual/background requests.
 * The caller's resolver must recheck access on every invocation. Cache and persistence are
 * private to the user; a changed source or profile never receives an obsolete paid result.
 * @param {string} userId
 * @param {string} listingId
 * @param {() => object|null} resolveListing
 * @returns {Promise<object>}
 */
export async function evaluateStoredFit(userId, listingId, resolveListing) {
  const listing = resolveListing();
  if (!listing) throw new FitEvaluationError('not_found', 404);
  const profile = getFitProfile(userId);
  if (!profile.criteria.length) throw new FitEvaluationError('profile_required', 400);
  const current = getFitResult(userId, listingId);
  if (current && !isFitStale(current, profile, listing)) return current;
  const key = JSON.stringify([userId, listingId]);
  if (inFlight.has(key)) {
    await inFlight.get(key);
    // The caller may have lost access while the coalesced request was running.
    const latest = resolveListing();
    if (!latest) throw new FitEvaluationError('not_found', 404);
    const result = getFitResult(userId, listingId);
    if (!result || result.evidenceHash !== fitEvidenceHash(getFitProfile(userId), latest))
      throw new FitEvaluationError('source_changed', 409);
    return result;
  }
  if (inFlight.size >= 4) throw new FitEvaluationError('busy', 429);

  // Start in a microtask so the guard is installed before any provider can settle.
  const task = Promise.resolve().then(async () => {
    const semanticDate = current?.semanticEvaluatedAt || current?.evaluatedAt;
    const reuseSemantic =
      current?.evidenceHash === fitEvidenceHash(profile, listing) &&
      Number.isFinite(Date.parse(semanticDate)) &&
      Date.now() - Date.parse(semanticDate) < 86400000;
    const result = await evaluateFit(
      profile,
      listing,
      reuseSemantic
        ? {
            semantic: async () => ({
              model: current.model,
              evaluatedAt: semanticDate,
              results: current.criteria.filter((criterion) => criterion.kind === 'semantic'),
            }),
          }
        : {},
    );
    const latest = resolveListing();
    if (!latest) throw new FitEvaluationError('not_found', 404);
    if (fitEvidenceHash(getFitProfile(userId), latest) !== result.evidenceHash)
      throw new FitEvaluationError('source_changed', 409);
    saveFitResult(userId, listingId, result);
    return result;
  });
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key);
  }
}
