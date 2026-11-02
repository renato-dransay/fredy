/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PORTALS, portalUrl } from '../../lib/services/autoApply/portals.js';
import { WriteBarrier, installBrowserGuard } from './networkGuard.js';
import { readPageState } from './pageState.js';

/** Resolve a real local Chrome executable without installing or modifying the user's browser. */
export function chromeExecutable(env = process.env) {
  const candidates = [
    env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error('Set CHROME_PATH to a Chromium executable.');
  return executable;
}

/** User/connection identifiers never become filesystem components directly. */
export function profileDirectory(root, connection) {
  return path.join(
    path.resolve(root),
    createHash('sha256').update(`${connection.userId}\0${connection.id}`).digest('hex'),
  );
}

/** Let Chromium flush its profile before SDK cleanup, bounded to five seconds. */
async function flushAndCloseBrowser(session, signal) {
  const endpoint = session.stagehand?.rpcClient?.browserWebSocketDebuggerUrl;
  if (!endpoint || session.guard?.healthy?.() !== true) return;
  const deadline = Date.now() + 5000;
  let pid;
  await new Promise((resolve) => {
    const socket = new WebSocket(endpoint);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      socket.close();
      resolve();
    };
    const timer = setTimeout(finish, 5000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })));
    socket.addEventListener('message', (event) => {
      try {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        if (signal.aborted || session.guard?.healthy?.() !== true) return finish();
        pid = response.result?.processInfo?.find((entry) => entry.type === 'browser')?.id;
        session.gracefulCloseRequested = true;
        socket.send(JSON.stringify({ id: 2, method: 'Browser.close' }));
      } catch {
        finish();
      }
    });
    socket.addEventListener('close', finish, { once: true });
    socket.addEventListener('error', finish, { once: true });
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
  // The debugging socket closes before Chromium finishes writing cookies. Wait for the actual
  // browser process; calling the SDK close immediately sends SIGTERM to its whole process group.
  while (!signal.aborted && Number.isInteger(pid) && pid > 1 && pid !== process.pid && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Close proof is the SDK's awaited process-group termination, after graceful profile flushing. */
export async function closeSession(session, { force = false } = {}) {
  if (session.closed) return;
  if (session.closing) {
    if (force) {
      session.closeAbort.abort();
      await session.browser.close();
    }
    return session.closing;
  }
  session.barrier.mode = 'blocked';
  session.closeAbort = new AbortController();
  if (force) session.closeAbort.abort();
  session.closing = (async () => {
    if (!force) await flushAndCloseBrowser(session, session.closeAbort.signal).catch(() => {});
    await session.browser.close();
    session.closed = true;
    await session.guard?.close();
    await session.stagehand?.close().catch(() => {});
  })();
  try {
    await session.closing;
  } catch (error) {
    session.closing = null;
    throw error;
  }
}

/** Start one isolated persistent profile. No model sees login screens or human input. */
export async function openSession(
  connection,
  { profileRoot, api, headless = false, executablePath = chromeExecutable() },
) {
  const { localBrowser, Stagehand } = await import('@browserbasehq/stagehand');
  if (!PORTALS[connection.portal]) throw new Error('unsupported_portal');
  const directory = profileDirectory(profileRoot, connection);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const browser = await localBrowser.launch({
    executablePath,
    headless,
    userDataDir: directory,
    preserveUserDataDir: true,
    viewport: { width: 1280, height: 900 },
    locale: 'de-DE',
    acceptDownloads: false,
  });
  try {
    const session = {
      connection,
      browser,
      stagehand: null,
      page: null,
      barrier: new WriteBarrier(connection.portal),
      guard: null,
      run: null,
      closed: false,
    };
    session.stagehand = await Stagehand.create({
      browser,
      logging: { level: 'off' },
      cache: false,
      model: {
        generate: async (input) => {
          if (!session.run || connection.controlMode !== 'agent') throw new Error('model_observation_not_authorized');
          const state = await readPageState(session.page, connection.accountIdentity);
          if (state.login) throw new Error('login_requires_human');
          return api.post('/model', { runId: session.run.id, leaseToken: session.run.leaseToken, ...input });
        },
      },
    });
    session.page = await browser.context.newPage();
    await session.page.goto('about:blank');
    session.guard = await installBrowserGuard(
      session.stagehand.rpcClient.browserWebSocketDebuggerUrl,
      session.page.pageId,
      session.barrier,
      async () => {
        await closeSession(session, { force: !session.gracefulCloseRequested });
      },
    );
    session.barrier.human(connection.controlMode === 'human');
    session.close = () => closeSession(session);
    await session.page.goto(PORTALS[connection.portal].home);
    return session;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** Only direct human commands reach this path. It never invokes an LLM. */
export async function humanCommand(session, command) {
  if (session.connection.controlMode !== 'human' || session.run) throw new Error('human_control_unavailable');
  const page = session.page;
  if (command.type === 'click' && Number.isFinite(command.x) && Number.isFinite(command.y))
    return page.click(command.x, command.y);
  if (command.type === 'type' && typeof command.text === 'string' && command.text.length <= 32768)
    return page.type(command.text);
  if (
    command.type === 'key' &&
    typeof command.key === 'string' &&
    /^(?:Enter|Tab|Backspace|Delete|Escape|PageDown|PageUp|Space|Arrow(?:Left|Right|Up|Down)|Control\+A|Meta\+A)$/.test(
      command.key,
    )
  )
    return page.keyPress(command.key);
  if (command.type === 'scroll' && [command.x, command.y, command.deltaY].every(Number.isFinite))
    return page.scroll(command.x, command.y, 0, command.deltaY);
  if (command.type === 'navigate' && portalUrl(session.connection.portal, command.url)) return page.goto(command.url);
  throw new Error('unsupported_human_command');
}

/** Qualification proves visible identity both before and after restarting this exact profile. */
export async function qualifySession(session, accountIdentity, options) {
  if (session.connection.controlMode !== 'human' || typeof accountIdentity !== 'string' || !accountIdentity.trim())
    throw new Error('account_identity_required');
  const before = await readPageState(session.page, accountIdentity);
  if (before.login || !before.accountVisible || !portalUrl(session.connection.portal, before.url))
    throw new Error('account_not_visible');
  const connection = { ...session.connection, accountIdentity };
  await session.close();
  const reopened = await openSession(connection, options);
  try {
    await reopened.page.goto(before.url);
    const after = await readPageState(reopened.page, accountIdentity);
    if (after.login || !after.accountVisible) throw new Error('login_did_not_persist');
    await options.api.post(`/connections/${connection.id}/qualify`, {
      accountIdentity,
      evidence: { url: after.url, authenticated: true, persisted: true },
    });
    return reopened;
  } catch (error) {
    await reopened.close();
    throw error;
  }
}
