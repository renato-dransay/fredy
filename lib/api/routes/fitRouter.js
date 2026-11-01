/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as listings from '../../services/storage/listingsStorage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import { isAdmin } from '../security.js';
import { getFitProfile, saveFitProfile, getFitResult, saveFitResult } from '../../services/fit/storage.js';
import { evaluateFit, fitEvidenceHash, isFitStale } from '../../services/fit/evaluate.js';
import { FitProviderError, fitProviderStatus } from '../../services/fit/jev.js';

const inFlight = new Map();

/** Register private preferences and source-bound fit assessments inside the authenticated API. */
export default async function fitPlugin(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.session?.currentUser) return reply.code(401).send({ error: 'Sign in to use apartment fit.' });
    if (request.method !== 'GET' && (await getSettings()).demoMode && !isAdmin(request)) {
      return reply.code(403).send({ error: 'Apartment fit cannot be changed in demo mode.' });
    }
  });
  app.get('/profile', async (request) => ({
    profile: getFitProfile(request.session.currentUser),
    provider: fitProviderStatus(),
  }));
  app.post('/profile', { bodyLimit: 80000 }, async (request, reply) => {
    try {
      return { profile: saveFitProfile(request.session.currentUser, request.body), provider: fitProviderStatus() };
    } catch {
      return reply.code(400).send({
        error:
          'Invalid profile. Use text/Markdown up to 32 KB, at most 30 valid criteria, weights 1–10, and walking limits 1–60 minutes.',
      });
    }
  });

  /** Look up source data only after checking this user's access, without revealing unknown IDs. */
  const sourceFor = (request) => {
    const userId = request.session.currentUser;
    const listingId = request.params.listingId;
    if (!listings.userCanAccessListing(listingId, userId, isAdmin(request))) return null;
    return listings.getListingById(listingId, userId, isAdmin(request));
  };
  app.get('/listings/:listingId', async (request, reply) => {
    const listing = sourceFor(request);
    if (!listing) return reply.code(404).send({ error: 'Listing not found or not accessible.' });
    const userId = request.session.currentUser;
    const profile = getFitProfile(userId);
    const result = getFitResult(userId, request.params.listingId);
    return { result, stale: isFitStale(result, profile, listing) };
  });
  app.post('/listings/:listingId/evaluate', { bodyLimit: 1024 }, async (request, reply) => {
    const listing = sourceFor(request);
    if (!listing) return reply.code(404).send({ error: 'Listing not found or not accessible.' });
    const userId = request.session.currentUser;
    const listingId = request.params.listingId;
    const profile = getFitProfile(userId);
    if (!profile.criteria.length)
      return reply.code(400).send({ error: 'Add apartment requirements before evaluating a listing.' });
    const current = getFitResult(userId, listingId);
    if (current && !isFitStale(current, profile, listing)) return { result: current, stale: false };
    const key = `${userId}:${listingId}`;
    if (inFlight.has(key)) return reply.code(409).send({ error: 'This listing is already being evaluated.' });
    if (inFlight.size >= 4) return reply.code(429).send({ error: 'Fit evaluation is busy. Try again shortly.' });
    inFlight.set(key, true);
    try {
      // A transient station outage can be retried without buying the unchanged semantic
      // assessment again. Keep its original age so repeated routing retries cannot extend it.
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
      const latest = sourceFor(request);
      if (!latest) return reply.code(404).send({ error: 'Listing not found or not accessible.' });
      if (fitEvidenceHash(getFitProfile(userId), latest) !== result.evidenceHash) {
        return reply
          .code(409)
          .send({ error: 'The requirements or listing changed during evaluation. Please evaluate again.' });
      }
      saveFitResult(userId, listingId, result);
      return { result, stale: false };
    } catch (error) {
      if (error instanceof FitProviderError) return reply.code(503).send({ error: error.message, code: error.code });
      return reply.code(503).send({
        error: 'Fit evaluation unavailable. The previous result has been kept.',
        code: 'evaluation_unavailable',
      });
    } finally {
      inFlight.delete(key);
    }
  });
}
