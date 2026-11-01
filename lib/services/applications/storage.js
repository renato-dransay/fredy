/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { userCanAccessListing } from '../storage/listingsStorage.js';
import { validEmail } from './config.js';

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

/** An API-safe application failure. Provider errors never become its message. */
export class ApplicationError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Application data is private even when its source listing is shared. */
export function requireListingAccess(userId, listingId) {
  if (!userId || typeof listingId !== 'string' || !userCanAccessListing(listingId, userId))
    throw new ApplicationError('Listing not found or access denied.', 404, 'not_found');
}

/** Return the current user's record; never use an administrator's broad listing visibility. */
export function applicationRow(userId, listingId) {
  return (
    SqliteConnection.query('SELECT * FROM application_records WHERE user_id=? AND listing_id=?', [
      userId,
      listingId,
    ])[0] || null
  );
}

/** Decode dates defensively and reject timezone-free appointment strings. */
export function normalizeDate(value) {
  if (value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new ApplicationError('Dates must include an ISO 8601 timezone.');
  return new Date(value).toISOString();
}

/** Timeline insertion with an optional durable reply deduplication key. */
export function addEvent(applicationId, kind, text, source = 'manual', dedupKey = null) {
  return SqliteConnection.execute(
    'INSERT OR IGNORE INTO application_events(id,application_id,kind,text,source,created_at,dedup_key) VALUES (?,?,?,?,?,?,?)',
    [nanoid(), applicationId, kind, text, source, new Date().toISOString(), dedupKey],
  );
}

/** Current delivery state includes unresolved reservations; a new HTTP key must not bypass one. */
export function sendState(row) {
  const send = SqliteConnection.query(
    "SELECT state FROM application_sends WHERE application_id=? AND (revision=? OR state IN ('dispatching','uncertain')) ORDER BY created_at DESC LIMIT 1",
    [row.id, row.revision],
  )[0];
  return send?.state || (row.auto_send_at ? 'queued' : 'not_sent');
}

/** Stable public shape with private mailbox/outbox internals omitted. */
export function serializeApplication(row) {
  if (!row) return null;
  const listing = SqliteConnection.query('SELECT title,link FROM listings WHERE id=?', [row.listing_id])[0] || {};
  return {
    id: row.id,
    listingId: row.listing_id,
    ...listing,
    status: row.status,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    visitAt: row.visit_at,
    followUpAt: row.follow_up_at,
    autoSendAt: row.auto_send_at,
    sendState: sendState(row),
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

/** Read one application and timeline, scoped through both listing access and record ownership. */
export function getApplication(userId, listingId) {
  requireListingAccess(userId, listingId);
  const row = applicationRow(userId, listingId);
  const events = row
    ? SqliteConnection.query(
        'SELECT id,kind,text,source,created_at AS createdAt FROM application_events WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT 200',
        [row.id],
      )
    : [];
  return { application: serializeApplication(row), events };
}

/** Read the user's visible pipeline; revoked shared listings disappear immediately. */
export function listApplications(userId) {
  const rows = SqliteConnection.query(
    'SELECT * FROM application_records WHERE user_id=? ORDER BY updated_at DESC LIMIT 1000',
    [userId],
  );
  return rows.filter((row) => userCanAccessListing(row.listing_id, userId)).map(serializeApplication);
}

/** Validate the entire explicitly reviewed envelope before allowing any external delivery. */
export function validateDraft(row) {
  if (!validEmail(row.recipient)) throw new ApplicationError('Enter one recipient email address.');
  if (!row.subject.trim() || /[\r\n]/.test(row.subject)) throw new ApplicationError('Enter a single-line subject.');
  if (!row.body.trim()) throw new ApplicationError('Enter an application message.');
  if (['rejected', 'accepted', 'withdrawn'].includes(row.status))
    throw new ApplicationError('Reopen this application before sending.');
}

/** Save reviewed drafts and scheduling fields atomically; concurrent sends prevent draft mutation. */
export function saveApplication(userId, listingId, patch) {
  requireListingAccess(userId, listingId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new ApplicationError('Application must be an object.');
  SqliteConnection.withTransaction(() => {
    let row = applicationRow(userId, listingId);
    const existing = row;
    if (row && ['dispatching', 'uncertain'].includes(sendState(row)))
      throw new ApplicationError(
        'Delivery is in progress or uncertain. Check the mailbox before changing this application.',
        409,
        'delivery_uncertain',
      );
    row = row || {
      id: nanoid(),
      user_id: userId,
      listing_id: listingId,
      status: 'draft',
      recipient: '',
      subject: '',
      body: '',
      visit_at: null,
      follow_up_at: null,
      auto_send_at: null,
      revision: 1,
    };
    if (patch.status !== undefined) {
      if (!APPLICATION_STATUSES.includes(patch.status)) throw new ApplicationError('Invalid application status.');
      row.status = patch.status;
    }
    let changedEnvelope = false;
    for (const key of ['recipient', 'subject', 'body']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'string' || patch[key].length > (key === 'body' ? 32768 : 512))
        throw new ApplicationError(`Invalid application ${key}.`);
      const value = key === 'body' ? patch[key] : patch[key].trim();
      if (key !== 'body' && /[\r\n\0]/.test(value)) throw new ApplicationError(`Invalid application ${key}.`);
      changedEnvelope ||= row[key] !== value;
      row[key] = value;
    }
    if (row.recipient && !validEmail(row.recipient)) throw new ApplicationError('Enter one recipient email address.');
    for (const [key, column] of [
      ['visitAt', 'visit_at'],
      ['followUpAt', 'follow_up_at'],
      ['autoSendAt', 'auto_send_at'],
    ]) {
      if (patch[key] !== undefined) row[column] = normalizeDate(patch[key]);
    }
    // A queued body is a reviewed snapshot. Editing it cancels that consent unless explicitly rescheduled.
    if (existing && changedEnvelope) {
      row.revision += 1;
      if (patch.autoSendAt === undefined) row.auto_send_at = null;
    }
    if (patch.status !== undefined && patch.status !== 'draft' && patch.autoSendAt === undefined)
      row.auto_send_at = null;
    if (row.auto_send_at) {
      validateDraft(row);
      if (Date.parse(row.auto_send_at) <= Date.now())
        throw new ApplicationError('Scheduled send time must be in the future.');
      if (
        SqliteConnection.query('SELECT id FROM application_sends WHERE application_id=? AND revision=?', [
          row.id,
          row.revision,
        ]).length
      )
        throw new ApplicationError(
          'This draft already has a delivery attempt. Edit it before scheduling a new message.',
          409,
        );
    }
    row.updated_at = new Date().toISOString();
    SqliteConnection.execute(
      `INSERT INTO application_records(id,user_id,listing_id,status,recipient,subject,body,visit_at,follow_up_at,auto_send_at,revision,updated_at)
      VALUES (@id,@user_id,@listing_id,@status,@recipient,@subject,@body,@visit_at,@follow_up_at,@auto_send_at,@revision,@updated_at)
      ON CONFLICT(user_id,listing_id) DO UPDATE SET status=excluded.status,recipient=excluded.recipient,subject=excluded.subject,body=excluded.body,
        visit_at=excluded.visit_at,follow_up_at=excluded.follow_up_at,auto_send_at=excluded.auto_send_at,revision=excluded.revision,updated_at=excluded.updated_at`,
      row,
    );
    addEvent(
      row.id,
      'updated',
      patch.status === 'submitted'
        ? 'Application marked submitted manually; no email delivery receipt.'
        : 'Application details saved.',
      'manual',
    );
  });
  return getApplication(userId, listingId);
}

/** Record private correspondence and visit notes; received messages do not grant new sending consent. */
export function recordApplicationEvent(userId, listingId, { kind, text } = {}) {
  if (
    !['note', 'reply', 'visit', 'follow_up'].includes(kind) ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 32768
  )
    throw new ApplicationError('Choose an event type and enter up to 32 KB of text.');
  requireListingAccess(userId, listingId);
  if (!applicationRow(userId, listingId)) saveApplication(userId, listingId, {});
  const row = applicationRow(userId, listingId);
  SqliteConnection.withTransaction(() => {
    addEvent(row.id, kind, text.trim());
    if (kind === 'reply')
      SqliteConnection.execute(
        "UPDATE application_records SET status='replied',auto_send_at=NULL,updated_at=? WHERE id=?",
        [new Date().toISOString(), row.id],
      );
  });
  return getApplication(userId, listingId);
}

/** Calendar text escaping prevents user/listing text becoming injected VEVENT properties. */
export function calendarEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Export a one-hour visit in UTC without allowing arbitrary calendar headers or attendees. */
export function visitCalendar(userId, listingId) {
  const { application } = getApplication(userId, listingId);
  if (!application?.visitAt) throw new ApplicationError('No visit is scheduled.', 404);
  const stamp = (date) =>
    new Date(date)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fredy//Apartment visits//EN',
    'BEGIN:VEVENT',
    `UID:${application.id}@fredy`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(application.visitAt)}`,
    `DTEND:${stamp(Date.parse(application.visitAt) + 3600000)}`,
    `SUMMARY:${calendarEscape(`Apartment visit: ${application.title || ''}`)}`,
    `DESCRIPTION:${calendarEscape(application.link)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** A user must reconcile ambiguous SMTP against their mailbox before any deliberate retry is allowed. */
export function resolveDelivery(userId, listingId, { outcome, note } = {}) {
  requireListingAccess(userId, listingId);
  if (!['sent', 'not_sent'].includes(outcome) || typeof note !== 'string' || !note.trim() || note.length > 4096)
    throw new ApplicationError('Record the mailbox check and whether the message was sent.');
  const row = applicationRow(userId, listingId);
  if (!row) throw new ApplicationError('No application exists.', 404);
  SqliteConnection.withTransaction(() => {
    const attempts = SqliteConnection.query(
      "SELECT id FROM application_sends WHERE application_id=? AND state='uncertain'",
      [row.id],
    );
    if (!attempts.length) throw new ApplicationError('There is no uncertain delivery to resolve.', 409);
    SqliteConnection.execute(
      "UPDATE application_sends SET state=?,updated_at=? WHERE application_id=? AND state='uncertain'",
      [outcome === 'sent' ? 'sent' : 'cancelled', new Date().toISOString(), row.id],
    );
    SqliteConnection.execute('UPDATE application_records SET status=?,revision=revision+?,updated_at=? WHERE id=?', [
      outcome === 'sent' ? 'submitted' : 'draft',
      outcome === 'not_sent' ? 1 : 0,
      new Date().toISOString(),
      row.id,
    ]);
    addEvent(
      row.id,
      'delivery_resolved',
      `${outcome === 'sent' ? 'Sent confirmed' : 'Not sent confirmed'} by manual mailbox check: ${note.trim()}`,
      'manual',
    );
  });
  return getApplication(userId, listingId);
}
