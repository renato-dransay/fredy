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
  resolveDelivery,
} from '../../services/applications/storage.js';
import { publicMailConfig, saveMailConfig } from '../../services/applications/config.js';
import { sendApplication, syncMailbox } from '../../services/applications/mail.js';

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
    '/mail',
    handle((request) => publicMailConfig(request.session.currentUser)),
  );
  app.post(
    '/mail',
    { bodyLimit: 16384 },
    handle((request, reply) => {
      try {
        return saveMailConfig(request.session.currentUser, request.body);
      } catch (error) {
        if (error.message.startsWith('Saved mail') || error.message.startsWith('Mail encryption')) throw error;
        return reply.code(400).send({ error: error.message });
      }
    }),
  );
  app.post(
    '/mail/sync',
    { bodyLimit: 1024 },
    handle((request) => syncMailbox(request.session.currentUser)),
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
  app.post(
    '/listings/:listingId/send',
    { bodyLimit: 1024 },
    handle((request) => {
      if (!Number.isInteger(request.body?.expectedRevision) || request.body.expectedRevision < 1)
        throw new ApplicationError('Save and review the current draft before sending.');
      return sendApplication(request.session.currentUser, request.params.listingId, request.body.idempotencyKey, {
        expectedRevision: request.body.expectedRevision,
      });
    }),
  );
  app.post(
    '/listings/:listingId/resolve-delivery',
    { bodyLimit: 8192 },
    handle((request) => resolveDelivery(request.session.currentUser, request.params.listingId, request.body)),
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
