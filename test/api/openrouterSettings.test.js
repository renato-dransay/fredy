/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const ctx = vi.hoisted(() => ({ db: null }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params = {}) => ctx.db.prepare(sql).all(params),
    execute: (sql, params = {}) => ctx.db.prepare(sql).run(params),
  },
}));
vi.mock('../../lib/utils.js', async (original) => ({
  ...(await original()),
  readConfigFromStorage: async () => ({ demoMode: false }),
}));
vi.mock('../../lib/services/storage/userStorage.js', () => ({ ensureDemoUserExists: vi.fn() }));
vi.mock('../../lib/services/tracking/Tracker.js', () => ({ trackPoi: vi.fn() }));

import settingsPlugin from '../../lib/api/routes/generalSettingsRoute.js';
import { getSettings, getPublicSettings, refreshSettingsCache } from '../../lib/services/storage/settingsStorage.js';
import { evaluateSemantic, fitProviderStatus } from '../../lib/services/fit/jev.js';

let app;
let admin;
const post = (payload) => app.inject({ method: 'POST', url: '/', payload });
const source = async () => (await app.inject({ method: 'GET', url: '/' })).json();

beforeEach(async () => {
  vi.stubEnv('OPENROUTER_API_KEY_PERSONAL', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-shared-key');
  ctx.db = new Database(':memory:');
  ctx.db.exec(`CREATE TABLE settings (id TEXT PRIMARY KEY, create_date INTEGER, name TEXT, value TEXT, user_id TEXT);
    CREATE UNIQUE INDEX settings_name ON settings(name, IFNULL(user_id, 'GLOBAL_SETTING'));`);
  await refreshSettingsCache();
  admin = true;
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.currentUser = { isAdmin: admin };
  });
  await app.register(settingsPlugin);
});

afterEach(async () => {
  await app.close();
  ctx.db.close();
  vi.unstubAllEnvs();
});

describe('write-only OpenRouter configuration', () => {
  it('persists, rotates and clears the key without returning it, and immediately updates the real consumer', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await fitProviderStatus()).toMatchObject({ configured: false });
    vi.stubEnv('OPENROUTER_API_KEY_PERSONAL', 'synthetic-environment-key');
    expect((await source()).openrouterKeySource).toBe('environment');

    for (const key of ['synthetic-ui-key', 'synthetic-rotated-key']) {
      const response = await post({ openrouterApiKey: `  ${key}  ` });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(key);
      expect((await getSettings()).openrouterApiKey).toBe(key);
      await refreshSettingsCache(); // A fresh read from persisted rows, as after restart.
      expect(await fitProviderStatus()).toMatchObject({ configured: true });
      const published = await source();
      expect(published.openrouterKeySource).toBe('settings');
      expect(published).not.toHaveProperty('openrouterApiKey');
      expect(await getPublicSettings()).not.toHaveProperty('openrouterApiKey');
      await expect(evaluateSemantic([{ text: 'Quiet' }], [], { request })).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      expect(request.mock.lastCall[1].headers.Authorization).toBe(`Bearer ${key}`);
    }

    await post({ openrouterApiKey: '' });
    await post({ openrouterApiKey: '   ' });
    await post({ interval: 30 });
    expect((await getSettings()).openrouterApiKey).toBe('synthetic-rotated-key');
    expect((await post({ openrouterApiKey: null })).statusCode).toBe(200);
    expect((await source()).openrouterKeySource).toBe('environment');
    expect((await getSettings()).openrouterApiKey).toBeUndefined();
    await expect(evaluateSemantic([{ text: 'Quiet' }], [], { request })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(request.mock.lastCall[1].headers.Authorization).toBe('Bearer synthetic-environment-key');
    vi.stubEnv('OPENROUTER_API_KEY_PERSONAL', '');
    expect(await fitProviderStatus()).toMatchObject({ configured: false });
    request.mockClear();
    await expect(evaluateSemantic([{ text: 'Quiet' }], [], { request })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([42, false, [], {}, 'x'.repeat(4097), 'synthetic\nkey', 'synthetic key', 'synthetic\0key'])(
    'rejects malformed credentials without changing other settings: %#',
    async (value) => {
      const response = await post({ openrouterApiKey: value, interval: 31 });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Invalid personal OpenRouter API key.');
      expect((await getSettings()).interval).toBeUndefined();
    },
  );

  it('refuses non-admin changes and withholds provider settings from their settings response', async () => {
    await post({ openrouterApiKey: 'synthetic-private-key' });
    admin = false;
    for (const value of ['synthetic-other-key', null]) {
      expect((await post({ openrouterApiKey: value })).statusCode).toBe(403);
    }
    expect((await getSettings()).openrouterApiKey).toBe('synthetic-private-key');
    expect(await source()).not.toHaveProperty('openrouterKeySource');
    expect(await source()).not.toHaveProperty('openrouterApiKey');
  });
});
