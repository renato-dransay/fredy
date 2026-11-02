/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
const state = vi.hoisted(() => ({
  db: null,
  settings: {},
  jobs: {},
  fit: {},
  demo: false,
  active: true,
  access: true,
  assessmentGate: null,
}));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (s, p = []) => state.db.prepare(s).all(p),
    execute: (s, p = []) => state.db.prepare(s).run(p),
    withTransaction: (f) => state.db.transaction(() => f(state.db))(),
  },
}));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: (id) => state.jobs[id],
  getJobs: () => Object.values(state.jobs),
}));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ demoMode: state.demo, openrouterApiKey: 'test-only' }),
  getUserSettings: (id) => state.settings[id] ?? {},
  upsertSettings: (patch, id) => {
    state.settings[id] = { ...state.settings[id], ...patch };
  },
  getAddresses: () => [],
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  getListingById: (id) => state.db.prepare('SELECT * FROM listings WHERE id=?').get(id),
  userCanAccessListing: () => state.access,
  applyMarketBenchmark: vi.fn(),
  applyScamSignals: vi.fn(),
  attachTravelTimes: vi.fn(),
}));
vi.mock('../../lib/services/listings/travelTimeSweeper.js', () => ({ updateTravelTimesForListings: vi.fn() }));
vi.mock('../../lib/services/fit/storage.js', () => ({
  getFitProfile: () => ({ criteria: [{ id: 'size', weight: 1 }] }),
  getFitResult: (u, id) => state.fit[`${u}:${id}`] ?? null,
}));
vi.mock('../../lib/services/fit/evaluate.js', () => ({ isFitStale: (r) => !r || r.stale === true }));
vi.mock('../../lib/services/fit/evaluationService.js', () => ({
  evaluateStoredFit: async (u, id) => {
    if (state.assessmentGate) await state.assessmentGate;
    state.fit[`${u}:${id}`] = { score: 90, coverage: 50, hardFailure: false };
  },
}));
vi.mock('../../lib/services/application/applicationService.js', () => ({
  buildApplicationLetter: async () => ({ text: 'Hello, I would like to apply.', missing: [], unknown: [] }),
}));
vi.mock('../../lib/services/sse/sse-broker.js', () => ({ sendToUser: vi.fn() }));
vi.mock('../../lib/services/deploymentGate.js', () => ({ isDeploymentActive: () => state.active }));

const { up: applicationMigration } =
  await import('../../lib/services/storage/migrations/sql/55.application-workflow.js');
const { up: migration } = await import('../../lib/services/storage/migrations/sql/63.auto-apply.js');
const { up: documentMigration } =
  await import('../../lib/services/storage/migrations/sql/64.applicant-document-descriptions.js');
const storage = await import('../../lib/services/autoApply/storage.js');
const service = await import('../../lib/services/autoApply/service.js');
const view = await import('../../lib/services/autoApply/browserView.js');
const { default: uiPlugin } = await import('../../lib/api/routes/autoApplyRouter.js');
const { default: workerPlugin } = await import('../../lib/api/routes/autoApplyWorkerRouter.js');
const { infer, checkModel } = await import('../../lib/services/autoApply/model.js');
let connection, token;
beforeEach(() => {
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys=ON');
  state.db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob');
    CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT);INSERT INTO jobs VALUES('job','alice'),('job2','alice');
    CREATE TABLE listings(id TEXT PRIMARY KEY,job_id TEXT,provider TEXT,title TEXT,description TEXT,address TEXT,link TEXT,created_at INTEGER,added_manually INTEGER,is_active INTEGER DEFAULT 1,manually_deleted INTEGER DEFAULT 0,price REAL,size REAL,rooms REAL,latitude REAL,longitude REAL,location_source TEXT,scam_signals TEXT,scam_override TEXT);`);
  applicationMigration(state.db);
  migration(state.db);
  documentMigration(state.db);
  state.settings = {
    alice: {
      autoApplyModel: { model: 'test/browser', checked: true },
      applicant_profile: { fullName: 'Alice', email: 'alice@example.test' },
    },
  };
  state.jobs = {
    job: {
      id: 'job',
      userId: 'alice',
      name: 'Search',
      enabled: true,
      provider: [{ id: 'immoscout', enabled: true }],
      blacklist: [],
    },
    job2: {
      id: 'job2',
      userId: 'alice',
      name: 'Other',
      enabled: true,
      provider: [{ id: 'immoscout', enabled: true }],
      blacklist: [],
    },
  };
  state.fit = {};
  state.demo = false;
  state.active = true;
  state.access = true;
  state.assessmentGate = null;
  const paired = storage.createConnection('alice', { portal: 'immoscout', mode: 'server', name: 'Browser' });
  connection = paired.connection;
  token = paired.token;
  state.db
    .prepare("UPDATE auto_apply_connections SET qualified=1,account_identity='Alice',control_mode='agent' WHERE id=?")
    .run(connection.id);
  connection = storage.authenticateWorker(token);
});
afterEach(() => state.db.close());
const rule = (job = 'job', patch = {}) =>
  storage.saveRule('alice', job, {
    enabled: true,
    minimumScore: 8,
    portals: ['immoscout'],
    documentIds: [],
    connectionIds: { immoscout: connection.id },
    ...patch,
  });
function insert(id = 'flat', job = 'job', manual = 0, link = 'https://www.immobilienscout24.de/expose/123') {
  state.db
    .prepare(
      'INSERT INTO listings(id,job_id,provider,title,description,address,link,created_at,added_manually,price,size,rooms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(id, job, 'immoscout', 'Flat', 'An apartment', 'Berlin', link, Date.now() + 1, manual, 1000, 70, 3);
  return state.db.prepare('SELECT * FROM auto_apply_runs WHERE listing_id=?').get(id);
}
async function ready(id = 'flat') {
  rule();
  insert(id);
  state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
  await service.assessCandidates();
  const result = await service.claim(connection);
  expect(result.run).toBeTruthy();
  return result.run;
}
const intent = (run) => ({
  leaseToken: run.leaseToken,
  url: run.url,
  advertKey: run.advertKey,
  message: run.letter,
  answers: { name: 'Alice' },
  documents: [],
  accountIdentity: 'Alice',
  attachmentsSupported: false,
});
const evidence = () => ({
  url: 'https://www.immobilienscout24.de/expose/123',
  advertKey: 'immoscout:123',
  accountIdentity: 'Alice',
  confirmationSelector: '[role=status]',
  confirmationText: 'Ihre Nachricht wurde gesendet',
  request: { url: 'https://www.immobilienscout24.de/contact/request', method: 'POST', status: 200, authorized: true },
});
async function server(user = 'alice') {
  const app = Fastify();
  app.addHook('preHandler', async (r) => {
    r.session = { currentUser: user };
  });
  await app.register(uiPlugin, { prefix: '/api/applications/auto-apply' });
  await app.register(workerPlugin, { prefix: '/api/applications/worker' });
  return app;
}

describe('atomic discovery and eligibility', () => {
  it('enqueues true new search/manual inserts, not old inventory, updates or rolled-back rows', () => {
    insert('old');
    rule();
    expect(state.db.prepare('SELECT * FROM auto_apply_runs').all()).toHaveLength(0);
    insert();
    insert('manual', 'job', 1);
    expect(state.db.prepare('SELECT origin FROM auto_apply_runs ORDER BY origin').all()).toEqual([
      { origin: 'manual' },
      { origin: 'search' },
    ]);
    state.db.prepare("UPDATE listings SET price=900 WHERE id='flat'").run();
    expect(state.db.prepare('SELECT * FROM auto_apply_runs').all()).toHaveLength(2);
    expect(() =>
      state.db.transaction(() => {
        insert('rollback');
        throw new Error('crash');
      })(),
    ).toThrow('crash');
    expect(state.db.prepare("SELECT * FROM auto_apply_runs WHERE listing_id='rollback'").all()).toHaveLength(0);
  });
  it('rejects unowned rules, invalid thresholds, unchecked models and foreign documents', () => {
    expect(() => storage.saveRule('bob', 'job', {})).toThrow('not owned');
    expect(() => rule('job', { minimumScore: 8.15 })).toThrow('0.1');
    storage.saveModel('alice', 'new/model');
    expect(() => rule()).toThrow('configure');
  });
  it('qualifies known-only score with unknown must-haves and unknown location but blocks confirmed failures', () => {
    rule();
    const run = insert();
    state.fit['alice:flat'] = { score: 90, coverage: 20, hardUnknown: true };
    state.jobs.job.spatialFilter = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    expect(service.eligibility(run).reason).toBeUndefined();
    state.fit['alice:flat'].hardFailure = true;
    expect(service.eligibility(run).reason).toBe('must_have_failed');
    state.fit['alice:flat'] = { score: null };
    expect(service.eligibility(run).reason).toBe('below_threshold');
    state.jobs.job.spatialFilter = { features: [] };
    expect(service.eligibility(run).reason).toBe('invalid_area');
  });
  it('rejects known specs, blacklist, scam and lost listing access independently of fit', () => {
    rule();
    const run = insert();
    state.fit['alice:flat'] = { score: 100 };
    state.jobs.job.specFilter = { minSize: 80 };
    expect(service.eligibility(run).reason).toBe('search_specs');
    state.jobs.job.specFilter = null;
    state.jobs.job.blacklist = ['apartment'];
    expect(service.eligibility(run).reason).toBe('blacklist');
    state.jobs.job.blacklist = [];
    state.db.prepare("UPDATE listings SET scam_override='scam' WHERE id='flat'").run();
    expect(service.eligibility(run).reason).toBe('scam');
    state.access = false;
    expect(service.eligibility(run).reason).toBe('listing_unavailable');
  });
  it.each(['cancel', 'pause'])('preserves %s during an in-flight assessment', async (action) => {
    rule();
    const row = insert();
    state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
    let release;
    state.assessmentGate = new Promise((resolve) => {
      release = resolve;
    });
    const batch = service.assessCandidates();
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.controlRun('alice', row.id, { action });
    release();
    await batch;
    expect(storage.runFor('alice', row.id).state).toBe(action === 'cancel' ? 'cancelled' : 'needs_input');
    expect((await service.claim(connection)).run).toBeNull();
  });
  it('recovers delayed assessments and ignores disabled generations', async () => {
    rule();
    const row = insert();
    state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
    await service.assessCandidates();
    expect(storage.runFor('alice', row.id).state).toBe('queued');
    rule('job', { enabled: false });
    expect(storage.runFor('alice', row.id).state).toBe('cancelled');
    rule();
    expect(storage.runFor('alice', row.id).state).toBe('cancelled');
  });
});

describe('leases and durable submission', () => {
  it('leases globally once and rejects wrong workers, stale tokens and disabled rules', async () => {
    const run = await ready();
    expect((await service.claim(connection)).run).toBeNull();
    expect(() => service.leased({ ...connection, id: 'different' }, run.id, run.leaseToken)).toThrow('lease');
    rule('job', { enabled: false });
    await expect(service.authorize(connection, run.id, intent(run))).rejects.toThrow();
  });
  it('freezes exact content, grants one send, verifies receipt and updates existing lifecycle', async () => {
    const run = await ready();
    await expect(service.authorize(connection, run.id, { ...intent(run), message: 'changed' })).rejects.toThrow(
      'content changed',
    );
    await expect(
      service.authorize(connection, run.id, { ...intent(run), answers: { income: 'invented' } }),
    ).rejects.toThrow('saved applicant fact');
    const grant = await service.authorize(connection, run.id, intent(run));
    expect(storage.runFor('alice', run.id).state).toBe('submitting');
    await service.consume(connection, run.id, { leaseToken: run.leaseToken, authorization: grant.authorization });
    await expect(
      service.consume(connection, run.id, { leaseToken: run.leaseToken, authorization: grant.authorization }),
    ).rejects.toThrow('consumed');
    expect(
      service.reportResult(connection, run.id, { leaseToken: run.leaseToken, state: 'submitted', evidence: evidence() })
        .state,
    ).toBe('submitted');
    expect(state.db.prepare("SELECT status,body FROM application_records WHERE user_id='alice'").get()).toEqual({
      status: 'submitted',
      body: run.letter,
    });
  });
  it('revokes prepared content when applicant facts or draft changes', async () => {
    const run = await ready();
    state.settings.alice.applicant_profile.fullName = 'Updated';
    await expect(service.authorize(connection, run.id, intent(run))).rejects.toThrow('profile or letter changed');
  });
  it('keeps a no-retry tombstone after ambiguous sending and listing deletion', async () => {
    const run = await ready();
    await service.authorize(connection, run.id, intent(run));
    state.db.prepare('UPDATE auto_apply_runs SET lease_until=0').run();
    service.recoverLeases();
    expect(storage.runFor('alice', run.id).state).toBe('uncertain');
    state.db.prepare("DELETE FROM listings WHERE id='flat'").run();
    expect(storage.runFor('alice', run.id).listing_id).toBeNull();
    insert('again');
    state.fit['alice:again'] = { score: 100 };
    const again = state.db.prepare("SELECT * FROM auto_apply_runs WHERE listing_id='again'").get();
    expect(service.eligibility(again).reason).toBe('already_attempted');
    expect(() => service.controlRun('alice', run.id, { action: 'resume' })).toThrow('cannot');
  });
  it('retries a transient pre-submit failure twice, but never overwrites a user cancellation', async () => {
    const run = await ready();
    expect(
      service.reportResult(connection, run.id, {
        leaseToken: run.leaseToken,
        state: 'failed',
        reason: 'browser_operation_failed',
      }).state,
    ).toBe('queued');
    state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
    const second = (await service.claim(connection)).run;
    service.controlRun('alice', second.id, { action: 'cancel' });
    expect(
      service.reportResult(connection, second.id, {
        leaseToken: second.leaseToken,
        state: 'failed',
        reason: 'browser_operation_failed',
      }).state,
    ).toBe('cancelled');
  });
  it('does not accept model success alone or confirmation for the wrong advert/account', async () => {
    const run = await ready();
    const grant = await service.authorize(connection, run.id, intent(run));
    await service.consume(connection, run.id, { leaseToken: run.leaseToken, authorization: grant.authorization });
    expect(
      service.reportResult(connection, run.id, {
        leaseToken: run.leaseToken,
        state: 'submitted',
        evidence: { ...evidence(), accountIdentity: 'Bob' },
      }).state,
    ).toBe('uncertain');
    expect(state.db.prepare('SELECT * FROM application_records').all()).toHaveLength(0);
  });
  it('limits pre-send retries and never permits sending during deployment drain', async () => {
    const run = await ready();
    state.db.prepare('UPDATE auto_apply_runs SET lease_until=0,attempts=3').run();
    service.recoverLeases();
    expect(storage.runFor('alice', run.id).state).toBe('failed');
    storage.setDraining(true);
    expect((await service.claim(connection)).run).toBeNull();
    expect(() => view.controlConnection('alice', connection.id, 'open')).toThrow('draining');
  });
});

describe('documents, browser privacy and authenticated APIs', () => {
  it('persists private explanations through upload and edit without changing the file or exposing bytes', async () => {
    const app = await server();
    const other = await server('bob');
    const anonymous = await server(null);
    const bytes = Buffer.from('%PDF-1.4 private document');
    try {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/api/applications/auto-apply/documents',
        payload: {
          filename: 'income.pdf',
          contentBase64: bytes.toString('base64'),
          description: '  Three monthly statements.  ',
        },
      });
      expect(uploaded.statusCode).toBe(200);
      const doc = uploaded.json();
      expect(doc.description).toBe('Three monthly statements.');
      expect(doc).not.toHaveProperty('content');
      const url = `/api/applications/auto-apply/documents/${doc.id}`;
      const edit = { method: 'PUT', url, payload: { description: 'Share with landlords for income verification.' } };
      expect((await other.inject(edit)).statusCode).toBe(404);
      expect((await anonymous.inject(edit)).statusCode).toBe(401);
      const saved = await app.inject(edit);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ ...doc, description: edit.payload.description });
      expect((await app.inject({ url })).rawPayload).toEqual(bytes);
      const listed = (await app.inject({ url: '/api/applications/auto-apply' })).json().documents[0];
      expect(listed.description).toBe(edit.payload.description);
      expect(listed).not.toHaveProperty('content');
      for (const invalid of [null, 123, {}, 'x'.repeat(2001)]) {
        expect((await app.inject({ ...edit, payload: { description: invalid } })).statusCode).toBe(400);
      }
      const cleared = await app.inject({ ...edit, payload: { description: '' } });
      expect(cleared.json().description).toBe('');
      expect(cleared.json().hash).toBe(doc.hash);
    } finally {
      await Promise.all([app.close(), other.close(), anonymous.close()]);
    }
  });
  it('sniffs and scopes bytes, excludes content from metadata, and refuses scriptable uploads', () => {
    const doc = storage.addDocument('alice', {
      filename: '../income.pdf',
      contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
    });
    expect(doc.filename).not.toContain('/');
    expect(doc).not.toHaveProperty('content');
    expect(storage.listDocuments('alice')[0]).not.toHaveProperty('content');
    expect(() => storage.documentFor('bob', doc.id, true)).toThrow('not found');
    expect(() =>
      storage.addDocument('alice', { filename: 'fake.pdf', contentBase64: Buffer.from('<html>').toString('base64') }),
    ).toThrow('PDF');
  });
  it('binds document hashes and requires every selected attachment when supported', async () => {
    const doc = storage.addDocument('alice', {
      filename: 'income.pdf',
      contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
    });
    rule('job', { documentIds: [doc.id] });
    insert();
    state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
    await service.assessCandidates();
    const { run } = await service.claim(connection);
    await expect(service.authorize(connection, run.id, { ...intent(run), attachmentsSupported: true })).rejects.toThrow(
      'not attached',
    );
    await service.authorize(connection, run.id, {
      ...intent(run),
      attachmentsSupported: true,
      documents: [{ id: doc.id, hash: doc.hash }],
      uploadReceipts: [{ documentId: doc.id, hash: doc.hash, attachmentId: 'upload-1' }],
    });
  });
  it('never exposes pairing hashes and enforces owner isolation on every view/control', async () => {
    expect(storage.overview('alice').connections[0]).not.toHaveProperty('token_hash');
    expect(() => view.readFrame('bob', connection.id)).toThrow('not found');
    const app = await server('bob');
    try {
      expect(
        (await app.inject({ url: `/api/applications/auto-apply/connections/${connection.id}/frame` })).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/applications/worker/claim' })).statusCode).toBe(401);
      const result = await app.inject({
        method: 'POST',
        url: '/api/applications/worker/claim',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(result.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('revokes worker tokens immediately and keeps browser login inputs ephemeral and human-only', () => {
    expect(() => view.browserInput('alice', connection.id, { type: 'type', text: 'private' })).toThrow('human');
    view.controlConnection('alice', connection.id, 'open');
    view.browserInput('alice', connection.id, { type: 'type', text: 'private' });
    const response = view.receiveFrame(connection, { imageBase64: 'AA==', url: 'https://www.immobilienscout24.de/' });
    expect(response.commands[0].text).toBe('private');
    expect(
      view.receiveFrame(connection, { imageBase64: 'AA==', url: 'https://www.immobilienscout24.de/' }).commands,
    ).toEqual([]);
    view.controlConnection('alice', connection.id, 'revoke');
    expect(() => storage.authenticateWorker(token)).toThrow('credential');
  });
  it('checks structured model configuration without exposing the credential', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ready":true}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.001 },
          }),
        ),
    );
    expect((await checkModel('alice', { request })).checked).toBe(true);
    const result = await infer('alice', { messages: [{ role: 'user', content: 'test' }] }, { request });
    expect(result.usage.cost).toBe(0.001);
    expect(JSON.stringify(result)).not.toContain('test-only');
  });
});

it.skipIf(process.env.TEST_AUTO_APPLY_BROWSER !== '1')(
  'integrates the real Chromium runner with authenticated worker routes and durable SQLite receipts',
  async () => {
    const { createServer } = await import('node:https');
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const { localBrowser, Stagehand } =
      await import('../../tools/auto-apply/node_modules/@browserbasehq/stagehand/dist/index.mjs');
    const { WriteBarrier, installBrowserGuard } = await import('../../tools/auto-apply/networkGuard.js');
    const { runApplication } = await import('../../tools/auto-apply/runner.js');
    const { chromeExecutable, closeSession } = await import('../../tools/auto-apply/runtime.js');
    const folder = await mkdtemp(path.join(tmpdir(), 'fredy-integrated-'));
    let browser, session, tls, app;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          path.join(folder, 'key.pem'),
          '-out',
          path.join(folder, 'cert.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=fixture.invalid',
        ],
        { stdio: 'ignore' },
      );
      let submissions = 0;
      tls = createServer(
        { key: await readFile(path.join(folder, 'key.pem')), cert: await readFile(path.join(folder, 'cert.pem')) },
        async (req, res) => {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          if (req.method === 'POST') {
            const payload = JSON.parse(raw);
            res.setHeader('Content-Type', 'application/json');
            if (req.url.includes('attachments'))
              res.end(
                JSON.stringify({
                  attachmentId: 'uploaded-document',
                  filename: payload.filename,
                  sha256: createHash('sha256').update(Buffer.from(payload.fileData, 'base64')).digest('hex'),
                }),
              );
            else {
              submissions++;
              expect(payload.exposeId).toBe('123');
              res.end('{"sent":true}');
            }
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><header><span data-testid="account-email">Alice</span></header><label>Name<input name="name" required></label><label>Nachricht<textarea name="message" required></textarea></label><input type="file" multiple accept="application/pdf"><button id="send" type="button">Nachricht senden</button><div role="status"></div><script>
      let attachmentIds=[];document.querySelector('[type=file]').addEventListener('change',async event=>{for(const file of event.target.files){const fileData=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file)});const r=await fetch('/application/attachments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,fileData})});attachmentIds.push((await r.json()).attachmentId)}});
      document.querySelector('#send').addEventListener('click',async()=>{const r=await fetch('/contact/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exposeId:'123',message:document.querySelector('textarea').value,sender:{name:document.querySelector('input').value},attachmentIds})});if(r.ok)document.querySelector('[role=status]').textContent='Ihre Nachricht wurde gesendet'});</script>`);
        },
      );
      await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const doc = storage.addDocument('alice', {
        filename: 'income.pdf',
        contentBase64: Buffer.from('%PDF-1.4 fixture').toString('base64'),
      });
      rule('job', { documentIds: [doc.id] });
      insert();
      state.db.prepare('UPDATE auto_apply_runs SET available_at=0').run();
      await service.assessCandidates();
      app = await server();
      const api = {
        post: async (endpoint, payload = {}) => {
          const response = await app.inject({
            method: 'POST',
            url: `/api/applications/worker${endpoint}`,
            headers: { authorization: `Bearer ${token}` },
            payload,
          });
          if (response.statusCode !== 200)
            throw new Error(`Fixture API ${endpoint}: ${response.statusCode} ${response.body}`);
          return response.json();
        },
        bytes: async (endpoint, lease) => {
          const response = await app.inject({
            url: `/api/applications/worker${endpoint}`,
            headers: { authorization: `Bearer ${token}`, 'x-lease-token': lease },
          });
          expect(response.statusCode).toBe(200);
          return response.rawPayload;
        },
      };
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (url, options) => {
        if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions') return realFetch(url, options);
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        const request = JSON.parse(options.body);
        const observation = JSON.parse(request.messages[1].content[0].text);
        const find = (predicate) => observation.actions.findIndex(predicate);
        let choice = find(
          (a) =>
            a.action === 'fill' &&
            a.fact === 'fullName' &&
            observation.controls.find((c) => c.id === a.controlId)?.name === 'name',
        );
        if (choice < 0) choice = find((a) => a.action === 'fill' && a.fact === 'letter');
        if (choice < 0) choice = find((a) => a.action === 'upload');
        if (choice < 0) choice = find((a) => a.action === 'submit');
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ choice }) } }],
            usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 },
          }),
        );
      });
      const { run } = await api.post('/claim');
      expect(run.documents[0].id).toBe(doc.id);
      browser = await localBrowser.launch({
        headless: true,
        executablePath: chromeExecutable(),
        args: [
          '--ignore-certificate-errors',
          `--host-resolver-rules=MAP www.immobilienscout24.de 127.0.0.1:${tls.address().port}`,
        ],
      });
      const stagehand = await Stagehand.create({
        browser,
        logging: { level: 'off' },
        model: {
          generate: async () => {
            throw new Error('Unexpected direct model call');
          },
        },
      });
      const page = await browser.context.newPage();
      await page.goto('about:blank');
      session = { browser, stagehand, page, barrier: new WriteBarrier('immoscout'), closed: false };
      session.close = () => closeSession(session);
      session.guard = await installBrowserGuard(
        stagehand.rpcClient.browserWebSocketDebuggerUrl,
        page.pageId,
        session.barrier,
        session.close,
      );
      const result = await runApplication({ run, session, api });
      expect(result, JSON.stringify(result)).toMatchObject({ state: 'submitted' });
      expect(await api.post(`/runs/${run.id}/result`, result)).toEqual({ state: 'submitted' });
      expect(submissions).toBe(1);
      const saved = state.db.prepare('SELECT * FROM auto_apply_receipts').get();
      expect(saved.state).toBe('submitted');
      expect(JSON.parse(saved.snapshot).uploadReceipts[0].attachmentId).toBe('uploaded-document');
      expect(state.db.prepare('SELECT status FROM application_records').get().status).toBe('submitted');
      expect(JSON.parse(storage.runFor('alice', run.id).usage).calls).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      if (session) await session.close();
      else if (browser) await browser.close();
      if (app) await app.close();
      if (tls) await new Promise((resolve) => tls.close(resolve));
      await rm(folder, { recursive: true, force: true });
    }
  },
  60000,
);
