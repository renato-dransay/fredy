/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExclusiveBadge from '../../ui/src/components/listings/ExclusiveBadge.jsx';
import {
  getExclusivityTime,
  readExclusivity,
  subscribeToExclusivityTime,
} from '../../ui/src/services/listings/exclusivity.js';

const language = vi.hoisted(() => ({ locale: 'de-DE' }));
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({ useLocale: () => language.locale }));

const now = Date.parse('2026-11-01T10:00:00Z');
const until = now + 2 * 60_000;
const listing = { is_exclusive: 1, exclusive_label: 'Nur für Suchen+', exclusive_until: until };

/** @param {Object|null} row A stored listing row. @returns {string} Actual rendered badge HTML. */
const render = (row) => renderToStaticMarkup(createElement(ExclusiveBadge, { listing: row }));

describe('listing exclusivity badge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    language.locale = 'de-DE';
  });
  afterEach(() => vi.useRealTimers());

  it('renders the portal label and a machine-readable deadline in the current locale', () => {
    const german = render(listing);
    expect(german).toContain('Nur für Suchen+');
    expect(german).toContain(`dateTime="${new Date(until).toISOString()}"`);
    expect(german).toContain(
      new Intl.DateTimeFormat('de-DE', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(until),
    );
    language.locale = 'en-US';
    const english = render(listing);
    expect(english).not.toBe(german);
    expect(english).toContain(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(until),
    );
  });

  it('uses Suchen+ for an active flag without a label or deadline', () => {
    const html = render({ is_exclusive: true, exclusive_label: '  ', exclusive_until: null });
    expect(html).toContain('Suchen+');
    expect(html).not.toContain('<time');
  });

  it.each([
    null,
    {},
    { is_exclusive: 0, exclusive_label: 'Suchen+' },
    { ...listing, exclusive_until: now },
    { ...listing, exclusive_until: now - 1 },
    { ...listing, exclusive_until: NaN },
  ])('renders nothing without an active unexpired claim: %j', (row) => {
    expect(render(row)).toBe('');
  });

  it('escapes portal labels as text', () => {
    const html = render({ is_exclusive: 1, exclusive_label: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('shares one minute clock and releases it after the last subscriber leaves', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToExclusivityTime(first);
    const unsubscribeSecond = subscribeToExclusivityTime(second);
    try {
      expect(vi.getTimerCount()).toBe(1);
      expect(readExclusivity(listing, getExclusivityTime())).not.toBeNull();
      vi.advanceTimersByTime(60_000);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(readExclusivity(listing, getExclusivityTime())).not.toBeNull();
      unsubscribeFirst();
      vi.advanceTimersByTime(60_000);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      expect(readExclusivity(listing, getExclusivityTime())).toBeNull();
      expect(render(listing)).toBe('');
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
