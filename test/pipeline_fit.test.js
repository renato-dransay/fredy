/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

const ctx = vi.hoisted(() => ({ calls: [], assessed: [], status: null, shared: [], channels: {} }));
vi.mock('../lib/services/fit/automation.js', () => ({
  assessAutomaticListings: async (jobId, listings) => ctx.assessed.push({ jobId, ids: listings.map((l) => l.id) }),
  automaticFitStatus: () => ctx.status,
}));
vi.mock('../lib/services/storage/jobStorage.js', () => ({
  getJob: (id) => ({ id, userId: 'user1', shared_with_user: ctx.shared }),
}));
vi.mock('../lib/services/storage/configuredAdapterStorage.js', () => ({ getChannel: (id) => ctx.channels[id] }));

beforeEach(() => {
  vi.resetModules();
  ctx.shareDuringFormatting = false;
  vi.doMock('../lib/services/providers/providerCountries.js', () => ({
    getCountriesForListing: async () => {
      if (ctx.shareDuringFormatting) ctx.shared = ['someone'];
      return ['de'];
    },
  }));
  vi.doMock('../lib/services/storage/jobStorage.js', () => ({
    getJob: (id) => ({ id, userId: 'user1', shared_with_user: ctx.shared }),
  }));
  vi.doMock('../lib/notification/notify.js', () => ({
    send: (serviceName, payload, configuration) => {
      ctx.calls.push({ serviceName, payload, configuration });
      return [Promise.resolve()];
    },
  }));
  ctx.calls = [];
  ctx.assessed = [];
  ctx.status = null;
  ctx.shared = [];
  ctx.channels = {
    private: { userId: 'user1', visibility: 'private' },
    shared: { userId: 'user1', visibility: 'everyone' },
    other: { userId: 'other-user', visibility: 'private' },
  };
  mockStore.setUserSettings({ language: 'en' });
});

async function pipeline() {
  const Fredy = await mockFredy();
  return new Fredy(
    {},
    {
      id: 'one',
      notificationAdapter: ['private', 'shared', 'other'].map((id) => ({ id: 'browser', configuredAdapterId: id })),
    },
    'example',
    {},
    null,
  );
}

const listing = () => ({ id: 'candidate', title: 'Apartment', price: 1000, size: 90, rooms: 3 });

describe('fit classification at the real notification boundary', () => {
  it.each([
    ['failed', 'Does not meet requirements'],
    ['unknown', 'Needs clarification'],
    ['matched', 'Meets requirements'],
    ['pending', 'Assessment pending'],
    ['unavailable', 'Assessment unavailable'],
  ])('shows %s only in the owner private channel', async (status, label) => {
    ctx.status = status;
    const runner = await pipeline();
    const rows = [listing()];
    expect(await runner._assessFit(rows)).toBe(rows);
    expect(ctx.assessed).toEqual([{ jobId: 'one', ids: ['candidate'] }]);
    await runner._notify(rows);
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[0].payload[0].title).toBe(`[${label}] Apartment`);
    expect(ctx.calls.slice(1).map((call) => call.payload[0].title)).toEqual(['Apartment', 'Apartment']);
    for (const call of ctx.calls) {
      expect(Object.keys(call.payload[0]).sort()).toEqual(['commute', 'id', 'price', 'rooms', 'size', 'title']);
    }
    expect(rows).toEqual([listing()]);
  });
  it('does not expose the owner classification through any channel of a shared job', async () => {
    ctx.status = 'failed';
    ctx.shared = ['someone'];
    const runner = await pipeline();
    await runner._notify([listing()]);
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls.every((call) => call.payload[0].title === 'Apartment')).toBe(true);
  });
  it('preserves one ordinary batch for jobs that have not opted in', async () => {
    const runner = await pipeline();
    await runner._notify([listing()]);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].configuration).toHaveLength(3);
    expect(ctx.calls[0].payload[0].title).toBe('Apartment');
  });
  it('rechecks privacy when a job becomes shared while notification formatting is awaiting', async () => {
    ctx.status = 'failed';
    ctx.shareDuringFormatting = true;
    const runner = await pipeline();
    await runner._notify([listing()]);
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls.every((call) => call.payload[0].title === 'Apartment')).toBe(true);
  });
});
