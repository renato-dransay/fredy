/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { ApplicationError } from '../../services/applications/storage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import {
  overview,
  saveRule,
  createConnection,
  addDocument,
  updateDocument,
  removeDocument,
  documentFor,
  saveModel,
  serializeRun,
} from '../../services/autoApply/storage.js';
import { checkModel } from '../../services/autoApply/model.js';
import { controlRun } from '../../services/autoApply/service.js';
import { controlConnection, readFrame, browserInput } from '../../services/autoApply/browserView.js';

/** Normalize failures without leaking upstream responses, tokens, documents or database contents. */
export const autoApplyHandler = (callback) => async (request, reply) => {
  try {
    return await callback(request, reply);
  } catch (error) {
    if (error instanceof ApplicationError)
      return reply.code(error.status).send({ error: error.message, code: error.code });
    return reply.code(500).send({ error: 'Auto-apply operation could not complete.' });
  }
};
/** Private user-facing controls, registered inside Fredy's authenticated route group. */
export default async function autoApplyPlugin(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.session?.currentUser) return reply.code(401).send({ error: 'Sign in to use auto-apply.' });
    if (request.method !== 'GET' && (await getSettings()).demoMode)
      return reply.code(403).send({ error: 'Auto-apply is unavailable in demo mode.' });
    reply.header('Cache-Control', 'no-store');
  });
  const user = (r) => r.session.currentUser;
  app.get(
    '/',
    autoApplyHandler((r) => overview(user(r))),
  );
  app.put(
    '/rules/:jobId',
    { bodyLimit: 20000 },
    autoApplyHandler((r) => saveRule(user(r), r.params.jobId, r.body)),
  );
  app.post(
    '/connections',
    { bodyLimit: 2000 },
    autoApplyHandler((r) => createConnection(user(r), r.body)),
  );
  app.post(
    '/connections/:id/control',
    { bodyLimit: 1000 },
    autoApplyHandler((r) => controlConnection(user(r), r.params.id, r.body?.action)),
  );
  app.get(
    '/connections/:id/frame',
    autoApplyHandler((r) => readFrame(user(r), r.params.id)),
  );
  app.post(
    '/connections/:id/input',
    { bodyLimit: 40000 },
    autoApplyHandler((r) => browserInput(user(r), r.params.id, r.body)),
  );
  app.post(
    '/documents',
    { bodyLimit: 14_100_000 },
    autoApplyHandler((r) => addDocument(user(r), r.body)),
  );
  app.delete(
    '/documents/:id',
    autoApplyHandler((r) => {
      removeDocument(user(r), r.params.id);
      return { ok: true };
    }),
  );
  app.put(
    '/documents/:id',
    { bodyLimit: 12000 },
    autoApplyHandler((r) => updateDocument(user(r), r.params.id, r.body)),
  );
  app.get(
    '/documents/:id',
    autoApplyHandler((r, reply) => {
      const doc = documentFor(user(r), r.params.id, true);
      return reply
        .type(doc.mimeType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`)
        .send(doc.content);
    }),
  );
  app.put(
    '/model',
    { bodyLimit: 1000 },
    autoApplyHandler((r) => saveModel(user(r), r.body?.model)),
  );
  app.post(
    '/model/check',
    autoApplyHandler((r) => checkModel(user(r))),
  );
  app.post(
    '/runs/:id/control',
    { bodyLimit: 6000 },
    autoApplyHandler((r) => serializeRun(controlRun(user(r), r.params.id, r.body))),
  );
}
