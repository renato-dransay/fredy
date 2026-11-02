/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { workerClient } from './client.js';
import { openSession, humanCommand, qualifySession } from './runtime.js';
import { runApplication } from './runner.js';

/** One outbound paired worker, usable on a server or desktop without an incoming listener. */
export async function startWorker({ baseUrl, token, profileRoot, signal, headless = false }) {
  const api = workerClient(baseUrl, token);
  const options = { profileRoot, api, headless };
  const sessions = new Map();
  let active = null;
  const closeAll = async () => {
    await Promise.all([...sessions.values()].map((session) => session.close()));
    sessions.clear();
  };
  const abort = () => {
    void closeAll();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      try {
        const work = await api.post('/claim');
        if (work.draining) {
          await closeAll();
          await api.post('/drained', { profilesClosed: true });
        } else {
          const connections = work.connections ?? [];
          const currentIds = new Set(connections.map((connection) => connection.id));
          for (const [id, session] of sessions)
            if (!currentIds.has(id) || session.closed) {
              await session.close();
              sessions.delete(id);
            }
          for (const connection of connections) {
            let session = sessions.get(connection.id);
            if (connection.controlMode === 'paused') {
              if (session) {
                await session.close();
                sessions.delete(connection.id);
              }
              continue;
            }
            if (!session) {
              session = await openSession(connection, options);
              sessions.set(connection.id, session);
            } else Object.assign(session.connection, connection);
            if (!session.run) session.barrier.human(connection.controlMode === 'human');
            if (!session.guard.healthy()) throw new Error('browser_guard_disconnected');
            const frame = await api.post(`/connections/${connection.id}/frame`, {
              imageBase64: Buffer.from(await session.page.screenshot({ type: 'png' })).toString('base64'),
              url: await session.page.url(),
            });
            if (frame.draining) {
              await closeAll();
              await api.post('/drained', { profilesClosed: true });
              break;
            }
            if (frame.mode) session.connection.controlMode = frame.mode;
            for (const command of frame.commands ?? []) {
              if (session.run) continue;
              if (command.type === 'verify_login') {
                session = await qualifySession(session, command.accountIdentity, options);
                sessions.set(connection.id, session);
              } else await humanCommand(session, command);
            }
          }
          if (work.run && !active) {
            const session = sessions.get(work.run.connectionId);
            if (!session || session.connection.controlMode !== 'agent') {
              await api.post(`/runs/${work.run.id}/result`, {
                leaseToken: work.run.leaseToken,
                state: 'needs_input',
                reason: 'browser_connection_unavailable',
              });
            } else {
              session.run = work.run;
              active = runApplication({ run: work.run, session, api })
                .then(async (result) => {
                  await api.post(`/runs/${work.run.id}/result`, result);
                })
                .catch(async () => {
                  await closeAll();
                })
                .finally(() => {
                  session.run = null;
                  active = null;
                });
            }
          }
        }
      } catch {
        // An expired token, transport loss or failed heartbeat never leaves an unattended browser.
        await closeAll();
        process.stderr.write('Auto-apply worker disconnected or paused; browser sessions closed.\n');
      }
      if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await closeAll();
    if (active) await active;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  const token = process.env.FREDY_WORKER_TOKEN_FILE
    ? (await readFile(process.env.FREDY_WORKER_TOKEN_FILE, 'utf8')).trim()
    : process.env.FREDY_WORKER_TOKEN;
  if (!process.env.FREDY_URL || !process.env.FREDY_BROWSER_PROFILE_DIR)
    throw new Error(
      'Set FREDY_URL and FREDY_BROWSER_PROFILE_DIR; pair a worker and supply its token through FREDY_WORKER_TOKEN_FILE.',
    );
  await startWorker({
    baseUrl: process.env.FREDY_URL,
    token,
    profileRoot: process.env.FREDY_BROWSER_PROFILE_DIR,
    signal: abort.signal,
  });
}
