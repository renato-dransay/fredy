/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => false) } }));
const fs = (await import('node:fs')).default;
const { deploymentMutationHook, isDeploymentActive } = await import('../../lib/services/deploymentGate.js');
afterEach(() => {
  vi.unstubAllEnvs();
  fs.existsSync.mockReturnValue(false);
});
describe('deployment acceptance boundary', () => {
  it('leaves ordinary installations active', () => {
    vi.stubEnv('FREDY_DEPLOYMENT_GATED', '');
    expect(isDeploymentActive()).toBe(true);
  });
  it('rejects user writes until the local activation marker exists', async () => {
    vi.stubEnv('FREDY_DEPLOYMENT_GATED', '1');
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await deploymentMutationHook({ method: 'POST', url: '/api/applications/listings/x/send' }, reply);
    expect(reply.code).toHaveBeenCalledWith(503);
    fs.existsSync.mockReturnValue(true);
    reply.code.mockClear();
    await deploymentMutationHook({ method: 'POST', url: '/api/applications/listings/x/send' }, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });
  it('allows health reads and login but not an arbitrary login-prefixed write', async () => {
    vi.stubEnv('FREDY_DEPLOYMENT_GATED', '1');
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    for (const [method, url] of [
      ['GET', '/api/deployment'],
      ['POST', '/api/login'],
      ['POST', '/api/login/logout'],
    ]) {
      await deploymentMutationHook({ method, url }, reply);
    }
    expect(reply.code).not.toHaveBeenCalled();
    await deploymentMutationHook({ method: 'POST', url: '/api/login/injected' }, reply);
    expect(reply.code).toHaveBeenCalledWith(503);
  });
  it('blocks legacy GET handlers that can write routing or image data', async () => {
    vi.stubEnv('FREDY_DEPLOYMENT_GATED', '1');
    for (const url of ['/api/transit/travel-times?listingId=x', '/api/listings/x/image']) {
      const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
      await deploymentMutationHook({ method: 'GET', url }, reply);
      expect(reply.code).toHaveBeenCalledWith(503);
    }
  });
});
