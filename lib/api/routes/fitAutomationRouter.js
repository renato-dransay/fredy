/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getJobs } from '../../services/storage/jobStorage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import { automaticFitJobs, saveAutomaticFitJobs } from '../../services/fit/automation.js';
import { isAdmin } from '../security.js';

/** Private per-job opt-in for bounded automatic assessment; no schema migration is required. */
export default async function fitAutomationPlugin(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.session?.currentUser) return reply.code(401).send({ error: 'Sign in to configure apartment fit.' });
    if (request.method !== 'GET' && (await getSettings()).demoMode && !isAdmin(request))
      return reply.code(403).send({ error: 'Automatic fit cannot be changed in demo mode.' });
  });
  const responseFor = (userId) => ({
    jobs: getJobs({ includeDisabled: true })
      .filter((job) => job.userId === userId)
      .map(({ id, name }) => ({ id, name })),
    jobIds: automaticFitJobs(userId).map(({ jobId }) => jobId),
  });
  app.get('/', async (request) => responseFor(request.session.currentUser));
  app.post('/', { bodyLimit: 16000 }, async (request, reply) => {
    try {
      saveAutomaticFitJobs(request.session.currentUser, request.body?.jobIds);
      return responseFor(request.session.currentUser);
    } catch {
      return reply.code(400).send({ error: 'Choose at most 100 jobs that you own.' });
    }
  });
}
