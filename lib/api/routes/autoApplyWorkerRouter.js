/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import db from '../../services/storage/SqliteConnection.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import {
  authenticateWorker,
  connectionFor,
  documentFor,
  fail,
  parse,
  changed,
  isDraining,
  modelConfig,
} from '../../services/autoApply/storage.js';
import {
  claim,
  heartbeat,
  authorize,
  consume,
  reportResult,
  leased,
  operational,
} from '../../services/autoApply/service.js';
import { infer, recordUsage } from '../../services/autoApply/model.js';
import { receiveFrame } from '../../services/autoApply/browserView.js';
import { portalUrl } from '../../services/autoApply/portals.js';
import { autoApplyHandler } from './autoApplyRouter.js';

/** Worker routes use connection-scoped bearer credentials, never a browser session cookie. */
export default async function workerPlugin(app) {
  app.addHook(
    'preHandler',
    autoApplyHandler(async (r, reply) => {
      if ((await getSettings()).demoMode)
        return reply.code(403).send({ error: 'Auto-apply is unavailable in demo mode.' });
      r.worker = authenticateWorker(r.headers.authorization?.replace(/^Bearer /, ''));
      reply.header('Cache-Control', 'no-store');
    }),
  );
  app.post(
    '/claim',
    autoApplyHandler(async (r) => {
      if (isDraining())
        return { run: null, connections: [connectionFor(r.worker.userId, r.worker.id)], draining: true };
      return claim(r.worker);
    }),
  );
  app.post(
    '/drained',
    { bodyLimit: 1000 },
    autoApplyHandler((r) => {
      if (r.body?.profilesClosed !== true) fail('Close browser profiles before acknowledging drain.');
      db.execute("UPDATE auto_apply_connections SET drained_at=?,status='drained' WHERE id=?", [
        Date.now(),
        r.worker.id,
      ]);
      return { ok: true };
    }),
  );
  app.post(
    '/runs/:id/heartbeat',
    { bodyLimit: 1000 },
    autoApplyHandler(async (r) => ({
      ...(await heartbeat(r.worker, r.params.id, r.body?.leaseToken)),
      draining: isDraining(),
    })),
  );
  app.post(
    '/runs/:id/authorize',
    { bodyLimit: 100000 },
    autoApplyHandler((r) => authorize(r.worker, r.params.id, r.body)),
  );
  app.post(
    '/runs/:id/consume',
    { bodyLimit: 2000 },
    autoApplyHandler((r) => consume(r.worker, r.params.id, r.body)),
  );
  app.post(
    '/runs/:id/result',
    { bodyLimit: 200000 },
    autoApplyHandler((r) => reportResult(r.worker, r.params.id, r.body)),
  );
  app.get(
    '/runs/:id/documents/:docId',
    autoApplyHandler((r, reply) => {
      const run = leased(r.worker, r.params.id, r.headers['x-lease-token'], ['running']);
      const snapshot = parse(run.snapshot);
      const selected = snapshot.documents?.find((d) => d.id === r.params.docId);
      if (!selected) fail('Document not selected for this application.', 404);
      const doc = documentFor(r.worker.userId, r.params.docId, true);
      if (doc.hash !== selected.hash) fail('Document changed.', 409);
      return reply.type(doc.mimeType).header('X-Content-Type-Options', 'nosniff').send(doc.content);
    }),
  );
  app.post(
    '/model',
    { bodyLimit: 310000 },
    autoApplyHandler(async (r) => {
      if (!(await operational()) || !modelConfig(r.worker.userId).checked) fail('Browser inference is paused.', 409);
      const run = leased(r.worker, r.body?.runId, r.body?.leaseToken, ['running']);
      if (connectionFor(r.worker.userId, r.worker.id).controlMode !== 'agent')
        fail('Browser is under human control.', 409);
      const usage = parse(run.usage, {});
      if ((usage.calls ?? 0) >= 100) fail('Application inference limit reached.', 409);
      const result = await infer(r.worker.userId, r.body);
      recordUsage(run, result.usage);
      return result;
    }),
  );
  app.post(
    '/connections/:id/frame',
    { bodyLimit: 2_900_000 },
    autoApplyHandler((r) => {
      if (r.params.id !== r.worker.id) fail('Browser connection not found.', 404);
      if (isDraining()) return { commands: [], mode: 'paused', draining: true };
      return receiveFrame(r.worker, r.body);
    }),
  );
  app.post(
    '/connections/:id/qualify',
    { bodyLimit: 5000 },
    autoApplyHandler((r) => {
      if (r.params.id !== r.worker.id) fail('Browser connection not found.', 404);
      const { accountIdentity, evidence } = r.body ?? {};
      if (
        typeof accountIdentity !== 'string' ||
        !accountIdentity.trim() ||
        accountIdentity.length > 200 ||
        evidence?.authenticated !== true ||
        evidence?.persisted !== true
      )
        fail('Verify account identity after restarting the browser.');
      let valid = false;
      try {
        valid = Boolean(portalUrl(r.worker.portal, evidence.url));
      } catch {
        /* Invalid evidence is rejected below. */
      }
      if (!valid) fail('Login evidence must come from the selected portal.');
      db.execute(
        "UPDATE auto_apply_connections SET qualified=1,account_identity=?,status='login_verified',last_seen=?,drained_at=NULL WHERE id=?",
        [accountIdentity.trim(), Date.now(), r.worker.id],
      );
      changed(r.worker.userId);
      return connectionFor(r.worker.userId, r.worker.id);
    }),
  );
}
