/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { isAdmin } from '../security.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import {
  ApplicationError,
  getApplication,
  listApplications,
  saveApplication,
  recordApplicationEvent,
  visitCalendar,
} from '../../services/applications/storage.js';

/** Private per-user apartment applications; caller authentication is supplied by the parent plugin. */
export default async function applicationsPlugin(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.session?.currentUser) return reply.code(401).send({ error: 'Sign in to manage applications.' });
    if (request.method !== 'GET' && (await getSettings()).demoMode && !isAdmin(request))
      return reply.code(403).send({ error: 'Applications cannot be changed in demo mode.' });
  });
  const handle = (callback) => async (request, reply) => {
    try {
      return await callback(request, reply);
    } catch (error) {
      if (error instanceof ApplicationError)
        return reply.code(error.status).send({ error: error.message, code: error.code });
      return reply.code(500).send({ error: 'Application operation failed. Check your configuration and retry.' });
    }
  };
  app.get(
    '/',
    handle((request) => ({ applications: listApplications(request.session.currentUser) })),
  );
  app.get(
    '/listings/:listingId',
    handle((request) => getApplication(request.session.currentUser, request.params.listingId)),
  );
  app.post(
    '/listings/:listingId',
    { bodyLimit: 40000 },
    handle((request) => saveApplication(request.session.currentUser, request.params.listingId, request.body)),
  );
  app.post(
    '/listings/:listingId/events',
    { bodyLimit: 40000 },
    handle((request) => recordApplicationEvent(request.session.currentUser, request.params.listingId, request.body)),
  );
  app.get(
    '/listings/:listingId/visit.ics',
    handle((request, reply) =>
      reply
        .type('text/calendar; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="apartment-visit.ics"')
        .send(visitCalendar(request.session.currentUser, request.params.listingId)),
    ),
  );
}
