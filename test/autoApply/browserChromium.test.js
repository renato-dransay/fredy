/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WriteBarrier, installBrowserGuard } from '../../tools/auto-apply/networkGuard.js';
import { readPageState } from '../../tools/auto-apply/pageState.js';
import { runApplication } from '../../tools/auto-apply/runner.js';
import { chromeExecutable, closeSession } from '../../tools/auto-apply/runtime.js';

const enabled = process.env.TEST_AUTO_APPLY_BROWSER === '1';
const suite = enabled ? describe : describe.skip;
let directory, server, port, Stagehand, localBrowser;
const requests = [];
const bodies = [];
let uploadFailure = false;
const fixture = (host) => {
  const portal = host.includes('immobilienscout')
    ? 'immoscout'
    : host.includes('immowelt')
      ? 'immowelt'
      : 'kleinanzeigen';
  const idKey = { immoscout: 'exposeId', immowelt: 'estateId', kleinanzeigen: 'adId' }[portal];
  const sendPath = { immoscout: '/contact/request', immowelt: '/api/inquiry', kleinanzeigen: '/s-anfrage.html' }[
    portal
  ];
  const uploadPath = portal === 'kleinanzeigen' ? '/m-ajax-bff/conversations/attachments' : '/application/attachments';
  return `<!doctype html><html><body><header><span data-testid="account-email">ada@example.invalid</span></header>
  <main><h1>Apartment</h1><label>Vorname<input name="firstName" required></label><label>Nachricht<textarea name="message" required></textarea></label><input type="file" name="documents" multiple accept="application/pdf"><button type="button" id="send">Nachricht senden</button><div role="status"></div></main>
  <script>let attachmentIds=[];document.querySelector('[type=file]').addEventListener('change',async(event)=>{for(const file of event.target.files){const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(file);});const response=await fetch('${uploadPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,fileData:data})});if(response.ok)attachmentIds.push((await response.json()).attachmentId);}});
  document.querySelector('#send').addEventListener('click',async()=>{const body={${idKey}:'123',message:document.querySelector('textarea').value,sender:{firstName:document.querySelector('input').value},attachmentIds};const response=await fetch('${sendPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(response.ok)document.querySelector('[role=status]').textContent='Ihre Nachricht wurde gesendet';});</script></body></html>`;
};

suite('real Chromium fixture applications (no external traffic or model calls)', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'fredy-browser-fixtures-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(directory, 'key.pem'),
        '-out',
        path.join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=fredy-fixture.invalid',
      ],
      { stdio: 'ignore' },
    );
    server = createServer(
      { key: await readFile(path.join(directory, 'key.pem')), cert: await readFile(path.join(directory, 'cert.pem')) },
      async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push({ method: request.method, url: request.url });
        if (request.method === 'POST') {
          bodies.push(JSON.parse(body));
          if (request.url.includes('attachments')) {
            if (uploadFailure) {
              response.writeHead(500);
              response.end('{}');
              return;
            }
            const value = JSON.parse(body);
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({
                attachmentId: 'fixture-file',
                filename: value.filename,
                sha256: createHash('sha256').update(Buffer.from(value.fileData, 'base64')).digest('hex'),
              }),
            );
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          response.end('{"sent":true}');
          return;
        }
        response.setHeader('Content-Type', 'text/html');
        response.end(fixture(request.headers.host));
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    ({ Stagehand, localBrowser } =
      await import('../../tools/auto-apply/node_modules/@browserbasehq/stagehand/dist/index.mjs'));
  }, 60000);
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function session(portal, userDataDir) {
    const hosts = ['www.immobilienscout24.de', 'www.immowelt.de', 'www.kleinanzeigen.de'];
    const browser = await localBrowser.launch({
      headless: true,
      executablePath: chromeExecutable(),
      ...(userDataDir ? { userDataDir, preserveUserDataDir: true } : {}),
      args: [
        '--ignore-certificate-errors',
        `--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(', ')}`,
      ],
    });
    const stagehand = await Stagehand.create({
      browser,
      logging: { level: 'off' },
      model: {
        generate: async () => {
          throw Error('Unexpected inference');
        },
      },
    });
    const page = await browser.context.newPage();
    await page.goto('about:blank');
    const barrier = new WriteBarrier(portal);
    const value = { browser, stagehand, page, barrier, closed: false };
    value.close = () => closeSession(value);
    value.guard = await installBrowserGuard(stagehand.rpcClient.browserWebSocketDebuggerUrl, page.pageId, barrier, () =>
      closeSession(value, { force: !value.gracefulCloseRequested }),
    );
    return value;
  }
  const urls = {
    immoscout: 'https://www.immobilienscout24.de/expose/123',
    immowelt: 'https://www.immowelt.de/expose/123',
    kleinanzeigen: 'https://www.kleinanzeigen.de/s-anzeige/flat/123-203-4',
  };
  const bytes = Buffer.from('%PDF-1.4 fixture document');
  const document = {
    id: 'doc',
    filename: 'applicant.pdf',
    mimeType: 'application/pdf',
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
  function apiFor(onAuthorize = () => {}) {
    return {
      bytes: async () => bytes,
      post: async (endpoint, input) => {
        if (endpoint.endsWith('heartbeat')) return { active: true };
        if (endpoint === '/model') {
          const state = JSON.parse(input.messages[0].content[0].text);
          const choose = (predicate) => state.actions.findIndex(predicate);
          let choice = choose(
            (action) =>
              action.action === 'fill' &&
              action.fact === 'firstName' &&
              state.controls.find((control) => control.id === action.controlId)?.name === 'firstName',
          );
          if (choice < 0) choice = choose((action) => action.action === 'fill' && action.fact === 'letter');
          if (choice < 0) choice = choose((action) => action.action === 'upload');
          if (choice < 0) choice = choose((action) => action.action === 'submit');
          return { structuredContent: { choice } };
        }
        if (endpoint.endsWith('authorize')) {
          onAuthorize(input);
          return { authorization: 'one-use', expiresAt: Date.now() + 10000 };
        }
        if (endpoint.endsWith('consume')) return { allowed: true };
        throw Error('Unexpected endpoint');
      },
    };
  }
  for (const portal of Object.keys(urls))
    it(`fills, verifies upload and sends once on ${portal}`, async () => {
      const live = await session(portal);
      const start = requests.length;
      try {
        let intent;
        const run = {
          id: 'run',
          leaseToken: 'lease',
          portal,
          url: urls[portal],
          advertKey: `${portal}:123`,
          accountIdentity: 'ada@example.invalid',
          letter: 'I am interested.',
          profile: { firstName: 'Ada' },
          documents: [document],
        };
        const result = await runApplication({
          run,
          session: live,
          api: apiFor((value) => {
            intent = value;
          }),
        });
        expect(
          result,
          JSON.stringify({
            result,
            receipt: live.barrier.receipt,
            blocked: live.barrier.blocked,
            requests: requests.slice(start),
          }),
        ).toMatchObject({ state: 'submitted' });
        expect(intent.uploadReceipts).toEqual([
          { documentId: 'doc', hash: document.hash, attachmentId: 'fixture-file' },
        ]);
        expect(
          requests.slice(start).filter((request) => request.method === 'POST' && !request.url.includes('attachments')),
        ).toHaveLength(1);
        expect(bodies.at(-1).message).toBe('I am interested.');
      } finally {
        await live.close();
      }
    }, 60000);
  it('does not authorize a send when the portal rejects an upload', async () => {
    uploadFailure = true;
    const live = await session('immoscout');
    let authorized = false;
    try {
      const result = await runApplication({
        run: {
          id: 'run',
          leaseToken: 'lease',
          portal: 'immoscout',
          url: urls.immoscout,
          advertKey: 'immoscout:123',
          accountIdentity: 'ada@example.invalid',
          letter: 'Letter',
          profile: { firstName: 'Ada' },
          documents: [document],
        },
        session: live,
        api: apiFor(() => {
          authorized = true;
        }),
      });
      expect(result.state).toBe('needs_input');
      expect(authorized).toBe(false);
    } finally {
      uploadFailure = false;
      await live.close();
    }
  }, 60000);
  it('does not accept an advert contact profile or partial identity as login evidence', async () => {
    const live = await session('immoscout');
    try {
      await live.page.goto(urls.immoscout);
      await live.page.evaluate(() => {
        document.querySelector('[data-testid="account-email"]').remove();
        document.body.insertAdjacentHTML(
          'beforeend',
          '<nav>Ada</nav><div class="agent-profile">ada@example.invalid</div>',
        );
      });
      expect((await readPageState(live.page, 'ada@example.invalid')).accountVisible).toBe(false);
      expect((await readPageState(live.page, 'Ada')).accountVisible).toBe(false);
    } finally {
      await live.close();
    }
  }, 60000);
  it('closes the browser immediately when the network guard disconnects', async () => {
    const live = await session('immoscout');
    await live.page.goto(urls.immoscout);
    await live.guard.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(live.closed).toBe(true);
    await expect(live.page.locator('#send').click()).rejects.toThrow();
    await live.close();
  }, 60000);
  it('preserves newly written login cookies and local storage across a profile restart', async () => {
    const profile = path.join(directory, 'persistent-profile');
    let live = await session('immoscout', profile);
    try {
      await live.page.goto(urls.immoscout);
      await live.page.evaluate(() => {
        document.cookie = 'fredy_fixture=retained; Max-Age=3600; Secure; SameSite=Lax';
        localStorage.setItem('fredy_fixture', 'retained');
      });
      await live.close();
      expect(live.closed).toBe(true);
      live = await session('immoscout', profile);
      await live.page.goto(urls.immoscout);
      expect(
        await live.page.evaluate(() => ({
          cookie: document.cookie.includes('fredy_fixture=retained'),
          stored: localStorage.getItem('fredy_fixture'),
        })),
      ).toEqual({ cookie: true, stored: 'retained' });
    } finally {
      await live.close();
    }
  }, 60000);
});
