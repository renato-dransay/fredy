/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'replied',
  'visit_scheduled',
  'follow_up',
  'rejected',
  'accepted',
  'withdrawn',
];
export const CRITERION_KINDS = ['semantic', 'min_rooms', 'min_size', 'max_price', 'station_line'];

/** Suggest editable criteria from document lines, without inferring bedrooms from room counts. */
export function criteriaFromDocument(document, makeId = () => crypto.randomUUID()) {
  return String(document ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((text) => ({ id: makeId(), text, required: false, weight: 1, kind: 'semantic' }));
}

/** Convert a datetime-local input to a UTC instant. Invalid values never become an implicit date. */
export function utcFromLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date');
  return date.toISOString();
}

/** Render a stored instant for a browser-local date/time control. */
export function localFromUtc(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Terminal decisions do not keep appearing as overdue follow-ups. */
export function isFollowUpDue(application, now = Date.now()) {
  if (['accepted', 'rejected', 'withdrawn'].includes(application.status)) return false;
  const due = Date.parse(application.followUpAt);
  return Number.isFinite(due) && due <= now;
}
