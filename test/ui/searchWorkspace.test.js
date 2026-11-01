/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  criteriaFromDocument,
  utcFromLocal,
  localFromUtc,
  isFollowUpDue,
  mailSettingsPayload,
  sendNeedsReview,
} from '../../ui/src/services/searchWorkspace.js';
import {
  loadFit,
  evaluateFit,
  saveApplication,
  sendApplication,
  resolveApplicationDelivery,
  saveMailSettings,
  visitCalendarUrl,
} from '../../ui/src/services/searchWorkspaceClient.js';

afterEach(() => vi.unstubAllGlobals());

describe('requirements document suggestions', () => {
  it('leaves subjective requirements and bedrooms as editable semantic criteria', () => {
    let counter = 0;
    const result = criteriaFromDocument(
      '# Our apartment\n- Two bedrooms\n\n* Large kitchen\n3. Unfurnished',
      () => `r${++counter}`,
    );
    expect(result.map((criterion) => criterion.text)).toEqual(['Two bedrooms', 'Large kitchen', 'Unfurnished']);
    expect(result.every((criterion) => criterion.kind === 'semantic' && !criterion.required)).toBe(true);
    expect(result.map((criterion) => criterion.id)).toEqual(['r1', 'r2', 'r3']);
  });
  it('bounds imported suggestions without silently evaluating them', () => {
    expect(criteriaFromDocument(Array.from({ length: 50 }, (_, i) => `Need ${i}`).join('\n'), () => 'id')).toHaveLength(
      30,
    );
    expect(criteriaFromDocument('\n# title\n')).toEqual([]);
  });
});

describe('application dates and follow-ups', () => {
  it('round-trips local inputs without dropping their time zone offset', () => {
    const value = '2026-11-20T14:30';
    expect(localFromUtc(utcFromLocal(value))).toBe(value);
    expect(utcFromLocal('')).toBeNull();
    expect(localFromUtc('invalid')).toBe('');
    expect(() => utcFromLocal('invalid')).toThrow();
  });
  it('marks only unfinished applications with elapsed follow-up dates as due', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(isFollowUpDue({ status: 'replied', followUpAt: '2026-11-20T11:59:00Z' }, now)).toBe(true);
    expect(isFollowUpDue({ status: 'accepted', followUpAt: '2026-11-19T11:59:00Z' }, now)).toBe(false);
    expect(isFollowUpDue({ status: 'draft', followUpAt: '2026-11-21T11:59:00Z' }, now)).toBe(false);
    expect(isFollowUpDue({ status: 'draft', followUpAt: null }, now)).toBe(false);
  });
  it('blocks retry while transport acceptance is uncertain or in progress', () => {
    expect(sendNeedsReview('uncertain')).toBe(true);
    expect(sendNeedsReview('dispatching')).toBe(true);
    expect(sendNeedsReview('not_sent')).toBe(false);
  });
});

describe('mail configuration edits', () => {
  it('omits blank passwords but preserves an explicit credential-clear request', () => {
    const result = mailSettingsPayload({
      smtp: { host: 'mail.example.test', port: '465', password: '', configured: true, passwordSet: true },
      imap: { host: 'imap.example.test', port: '993', password: null, configured: true },
    });
    expect(result.smtp).toEqual({ host: 'mail.example.test', port: 465 });
    expect(result.imap.password).toBeNull();
    expect(result.imap).not.toHaveProperty('configured');
  });
});

describe('workspace API boundaries', () => {
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });

  it('reading a fit result cannot initiate evaluation', async () => {
    const request = vi.fn().mockResolvedValue(respond({ result: null, stale: false }));
    vi.stubGlobal('fetch', request);
    expect(await loadFit('flat/one')).toEqual({ result: null, stale: false });
    expect(request.mock.calls[0][0]).toBe('/api/fit/listings/flat%2Fone');
    expect(request.mock.calls[0][1]).not.toHaveProperty('method');
  });
  it('preserves the actionable not-configured provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ error: 'Jev not configured', code: 'not_configured' }, 503)),
    );
    await expect(evaluateFit('flat')).rejects.toMatchObject({ status: 503, json: { code: 'not_configured' } });
  });
  it('saving a draft is distinct from submitting it and retains one send idempotency key', async () => {
    const request = vi
      .fn()
      .mockImplementation(() => Promise.resolve(respond({ application: { id: 'a' }, events: [] })));
    vi.stubGlobal('fetch', request);
    await saveApplication('flat', { body: 'Reviewed letter', recipient: 'landlord@example.test' });
    expect(request.mock.calls[0][0]).toBe('/api/applications/listings/flat');
    await sendApplication('flat', 'stable-key', 4);
    await sendApplication('flat', 'stable-key', 4);
    expect(request.mock.calls.slice(1).map((call) => JSON.parse(call[1].body))).toEqual([
      { idempotencyKey: 'stable-key', expectedRevision: 4 },
      { idempotencyKey: 'stable-key', expectedRevision: 4 },
    ]);
  });
  it('submits manual uncertainty evidence separately from another send attempt', async () => {
    const request = vi.fn().mockResolvedValue(respond({ application: {}, events: [] }));
    vi.stubGlobal('fetch', request);
    await resolveApplicationDelivery('flat', 'not_sent', 'Checked Sent folder and server log.');
    expect(request.mock.calls[0][0]).toBe('/api/applications/listings/flat/resolve-delivery');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      outcome: 'not_sent',
      note: 'Checked Sent folder and server log.',
    });
  });
  it('encodes calendar identifiers and sends mail passwords only to the settings mutation', async () => {
    const request = vi.fn().mockResolvedValue(respond({ smtp: { configured: true } }));
    vi.stubGlobal('fetch', request);
    await saveMailSettings({ smtp: { password: 'test-only' } });
    expect(request.mock.calls[0][0]).toBe('/api/applications/mail');
    expect(request.mock.calls[0][1].method).toBe('POST');
    expect(visitCalendarUrl('flat/one')).toBe('/api/applications/listings/flat%2Fone/visit.ics');
  });
});
