/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as listings from '../../services/storage/listingsStorage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import { isAdmin } from '../security.js';
import { getFitProfile, saveFitProfile, getFitResult } from '../../services/fit/storage.js';
import { isFitStale } from '../../services/fit/evaluate.js';
import { evaluateStoredFit, FitEvaluationError } from '../../services/fit/evaluationService.js';
import { FitProviderError, fitProviderStatus } from '../../services/fit/jev.js';

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
    provider: await fitProviderStatus(),
  }));
  app.post('/profile', { bodyLimit: 80000 }, async (request, reply) => {
    try {
      return {
        profile: saveFitProfile(request.session.currentUser, request.body),
        provider: await fitProviderStatus(),
      };
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
    try {
      const result = await evaluateStoredFit(userId, listingId, () => sourceFor(request));
      return { result, stale: false };
    } catch (error) {
      if (error instanceof FitEvaluationError) {
        return reply.code(error.statusCode).send({ error: 'Fit evaluation could not complete.', code: error.code });
      }
      if (error instanceof FitProviderError) return reply.code(503).send({ error: error.message, code: error.code });
      return reply.code(503).send({
        error: 'Fit evaluation unavailable. The previous result has been kept.',
        code: 'evaluation_unavailable',
      });
    }
  });
}
