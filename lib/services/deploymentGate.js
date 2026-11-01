/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';

/** A container-local marker cannot survive replacement or be supplied through a listing. */
export const ACTIVATION_MARKER = '/tmp/fredy-deployment-active';

/** Whether this process may accept mutations and start background work. */
export function isDeploymentActive() {
  return process.env.FREDY_DEPLOYMENT_GATED !== '1' || fs.existsSync(ACTIVATION_MARKER);
}

/** Wait for the host deployment worker to finish its read-only acceptance checks. */
export async function waitForDeploymentActivation() {
  while (!isDeploymentActive()) await setTimeout(250);
}

/** Pause mutations while the host can still restore the pre-migration snapshot. */
export async function deploymentMutationHook(request, reply) {
  const sessionRoute = /^\/api\/login(?:\/(?:logout))?\/?(?:\?.*)?$/.test(request.url);
  const path = request.url.split('?')[0].replace(/\/$/, '');
  // Several existing GET handlers refine routing or enqueue image writes. Only these
  // audited probes and static assets are safe before snapshot rollback is disabled.
  const safeRead =
    ['GET', 'HEAD'].includes(request.method) &&
    (!path.startsWith('/api/') ||
      ['/api/deployment', '/api/login/user', '/api/fit/profile', '/api/applications'].includes(path));
  if (!isDeploymentActive() && !safeRead && !sessionRoute) {
    return reply.code(503).send({ error: 'Deployment verification in progress. Please retry shortly.' });
  }
}
