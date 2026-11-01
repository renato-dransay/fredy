/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const listeners = new Set();
let clock = Date.now();
let timer;

/**
 * Subscribe badges to one shared minute clock, released when the last badge unmounts.
 *
 * @param {() => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribeToExclusivityTime(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    clock = Date.now();
    timer = setInterval(() => {
      clock = Date.now();
      listeners.forEach((notify) => notify());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** @returns {number} Cached time for React's external-store snapshot. */
export function getExclusivityTime() {
  return clock;
}

/** @returns {number} Fresh time during server rendering, which never subscribes. */
export function getServerExclusivityTime() {
  return Date.now();
}

/**
 * Read only an active portal exclusivity claim. A missing deadline keeps the claim active;
 * a supplied deadline at or before now expires it even if the stored flag has not changed.
 *
 * @param {{is_exclusive?: boolean|number, exclusive_label?: string|null, exclusive_until?: number|null}|null} listing
 * @param {number} [now=Date.now()] Epoch milliseconds.
 * @returns {{label: string, until: number|null}|null}
 */
export function readExclusivity(listing, now = Date.now()) {
  if (listing?.is_exclusive !== true && listing?.is_exclusive !== 1) return null;
  const until = listing.exclusive_until;
  if (until != null && (!Number.isFinite(until) || until <= now)) return null;
  return { label: listing.exclusive_label?.trim() || 'Suchen+', until: until ?? null };
}
