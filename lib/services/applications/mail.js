/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { userCanAccessListing } from '../storage/listingsStorage.js';
import { isDeploymentActive } from '../deploymentGate.js';
import { readMailSecrets, publicMailConfig, validEmail } from './config.js';
import {
  ApplicationError,
  applicationRow,
  requireListingAccess,
  validateDraft,
  getApplication,
  addEvent,
} from './storage.js';

const syncing = new Set();
const MAX_SOURCE_BYTES = 128 * 1024;

/** Send a durable reviewed snapshot once; ambiguous outcomes are never retried automatically. */
export async function sendApplication(
  userId,
  listingId,
  idempotencyKey,
  {
    createTransport = nodemailer.createTransport,
    active = isDeploymentActive,
    expectedRevision = null,
    scheduled = false,
  } = {},
) {
  requireListingAccess(userId, listingId);
  if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(idempotencyKey))
    throw new ApplicationError('A valid idempotency key is required.');
  const replay = SqliteConnection.query('SELECT * FROM application_sends WHERE user_id=? AND idempotency_key=?', [
    userId,
    idempotencyKey,
  ])[0];
  if (replay) {
    if (replay.application_id !== applicationRow(userId, listingId)?.id)
      throw new ApplicationError('Idempotency key belongs to a different application.', 409);
    return getApplication(userId, listingId);
  }
  if (!active()) throw new ApplicationError('Deployment is paused.', 503, 'deployment_paused');
  const config = readMailSecrets(userId).smtp;
  if (!config || !publicMailConfig(userId).smtp.configured || !validEmail(config.from))
    throw new ApplicationError(
      'Configure your SMTP connection before sending applications.',
      503,
      'mail_not_configured',
    );
  const row = applicationRow(userId, listingId);
  if (!row) throw new ApplicationError('Save a reviewed draft before sending.');
  if (expectedRevision !== null && row.revision !== expectedRevision)
    throw new ApplicationError(
      'The reviewed draft changed. Reload and review it before sending.',
      409,
      'draft_changed',
    );
  if (scheduled && (!row.auto_send_at || Date.parse(row.auto_send_at) > Date.now()))
    throw new ApplicationError('Scheduled draft changed or was cancelled.', 409, 'schedule_changed');
  validateDraft(row);
  const sendId = nanoid();
  const messageId = `<fredy-${crypto.randomUUID()}@${config.from.split('@')[1]}>`;
  const createdAt = new Date().toISOString();
  SqliteConnection.withTransaction(() => {
    const current = applicationRow(userId, listingId);
    if (
      !current ||
      current.revision !== row.revision ||
      current.status !== row.status ||
      current.auto_send_at !== row.auto_send_at
    )
      throw new ApplicationError('The reviewed draft changed. Review it again before sending.', 409, 'draft_changed');
    validateDraft(current);
    const previous = SqliteConnection.query(
      "SELECT state FROM application_sends WHERE application_id=? AND (revision=? OR state IN ('dispatching','uncertain')) LIMIT 1",
      [row.id, row.revision],
    );
    if (previous.length)
      throw new ApplicationError(
        'This draft already has a delivery attempt. Review its receipt before attempting another message.',
        409,
        'already_attempted',
      );
    // A record exists before opening the network connection. A crash from this point is uncertain.
    SqliteConnection.execute(
      "INSERT INTO application_sends(id,user_id,application_id,revision,idempotency_key,message_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'dispatching',?,?)",
      [sendId, userId, row.id, row.revision, idempotencyKey, messageId, createdAt, createdAt],
    );
    SqliteConnection.execute('UPDATE application_records SET auto_send_at=NULL WHERE id=?', [row.id]);
    addEvent(row.id, 'sending', 'Application delivery started; awaiting the SMTP server receipt.', 'smtp');
  });
  // This is intentionally rechecked after the claim and immediately before network I/O.
  if (!active() || !userCanAccessListing(listingId, userId)) {
    SqliteConnection.execute("UPDATE application_sends SET state='cancelled',updated_at=? WHERE id=?", [
      new Date().toISOString(),
      sendId,
    ]);
    throw new ApplicationError('Application access or deployment state changed before sending.', 409);
  }
  let transport;
  try {
    transport = createTransport({
      host: config.host,
      port: config.port,
      secure: Boolean(config.secure),
      requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: { rejectUnauthorized: true },
    });
    const response = await transport.sendMail({
      from: config.from,
      to: row.recipient,
      subject: row.subject,
      text: row.body,
      messageId,
      envelope: { from: config.from, to: [row.recipient] },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const accepted = (response.accepted || []).map((value) => String(value).toLowerCase());
    if (!accepted.includes(row.recipient.toLowerCase())) throw new Error('No explicit recipient acceptance.');
    SqliteConnection.withTransaction(() => {
      SqliteConnection.execute("UPDATE application_sends SET state='sent',updated_at=? WHERE id=?", [
        new Date().toISOString(),
        sendId,
      ]);
      // Always retain the outbox receipt, even if the listing was removed during the SMTP request.
      SqliteConnection.execute(
        "UPDATE application_records SET status='submitted',updated_at=? WHERE id=? AND user_id=?",
        [new Date().toISOString(), row.id, userId],
      );
      if (applicationRow(userId, listingId))
        addEvent(
          row.id,
          'submitted',
          `SMTP server accepted the application for ${row.recipient}. This is not confirmation the landlord read it.`,
          'smtp',
        );
    });
  } catch {
    SqliteConnection.withTransaction(() => {
      SqliteConnection.execute("UPDATE application_sends SET state='uncertain',updated_at=? WHERE id=?", [
        new Date().toISOString(),
        sendId,
      ]);
      if (applicationRow(userId, listingId))
        addEvent(
          row.id,
          'delivery_uncertain',
          'Delivery could not be confirmed. Check your Sent folder or mailbox before sending again; automatic retry is disabled.',
          'smtp',
        );
    });
  } finally {
    transport?.close?.();
  }
  return getApplication(userId, listingId);
}

/** Only server-recorded outbound message identifiers can associate a reply with a private application. */
export function matchReply(
  userId,
  { messageId, inReplyTo, references = [], text = '', subject = '', from = '' },
  mailboxKey = '',
) {
  if (typeof messageId !== 'string' || messageId.length > 1024 || !messageId.trim()) return false;
  const refs = [
    ...new Set(
      [inReplyTo, ...(Array.isArray(references) ? references : [references])].filter(
        (value) => typeof value === 'string' && value.length <= 1024,
      ),
    ),
  ].slice(0, 50);
  if (!refs.length) return false;
  const matches = SqliteConnection.query(
    `SELECT DISTINCT application_id FROM application_sends WHERE user_id=? AND message_id IN (${refs.map(() => '?').join(',')}) AND state IN ('sent','uncertain','dispatching')`,
    [userId, ...refs],
  );
  if (matches.length !== 1) return false;
  const row = SqliteConnection.query('SELECT * FROM application_records WHERE id=? AND user_id=?', [
    matches[0].application_id,
    userId,
  ])[0];
  if (!row || !userCanAccessListing(row.listing_id, userId)) return false;
  const summary = [
    `From: ${String(from).slice(0, 512)}`,
    `Subject: ${String(subject).slice(0, 512)}`,
    String(text).slice(0, 32768),
  ].join('\n');
  const dedup = crypto
    .createHash('sha256')
    .update(JSON.stringify([userId, mailboxKey, messageId]))
    .digest('hex');
  let added = false;
  SqliteConnection.withTransaction(() => {
    const result = addEvent(row.id, 'reply', summary, 'imap', dedup);
    added = result.changes > 0;
    if (added)
      SqliteConnection.execute(
        "UPDATE application_records SET status='replied',auto_send_at=NULL,updated_at=? WHERE id=?",
        [new Date().toISOString(), row.id],
      );
  });
  return added;
}

/** Fetch at most 100 bounded messages without changing mailbox flags. Credentials and protocol logs stay private. */
export async function syncMailbox(userId, { clientFactory, parseMessage } = {}) {
  if (syncing.has(userId))
    throw new ApplicationError('Inbox synchronization is already running.', 409, 'sync_in_progress');
  if (!isDeploymentActive()) throw new ApplicationError('Deployment is paused.', 503, 'deployment_paused');
  const config = readMailSecrets(userId).imap;
  if (!config || !publicMailConfig(userId).imap.configured)
    throw new ApplicationError('Configure your IMAP connection to detect replies.', 503, 'mail_not_configured');
  syncing.add(userId);
  let client;
  let lock;
  let timeout;
  const savedCiphertext = SqliteConnection.query('SELECT ciphertext FROM application_mail WHERE user_id=?', [userId])[0]
    ?.ciphertext;
  let matched = 0;
  let scanned = 0;
  try {
    const { ImapFlow } = clientFactory ? {} : await import('imapflow');
    const { simpleParser } = parseMessage ? {} : await import('mailparser');
    client = clientFactory
      ? clientFactory(config)
      : new ImapFlow({
          host: config.host,
          port: config.port || 993,
          secure: true,
          auth: { user: config.user, pass: config.password },
          logger: false,
          disableAutoIdle: true,
          socketTimeout: 20000,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          tls: { rejectUnauthorized: true },
        });
    // A protocol client can emit errors outside a pending operation; avoid unhandled process termination.
    client.on?.('error', () => {});
    timeout = setTimeout(() => client?.close?.(), 45000);
    timeout.unref?.();
    await client.connect();
    lock = await client.getMailboxLock(config.mailbox || 'INBOX', { readOnly: true });
    const validity = String(client.mailbox.uidValidity);
    const next = Number(client.mailbox.uidNext || 1);
    const saved = SqliteConnection.query('SELECT uid_validity,last_uid FROM application_mail WHERE user_id=?', [
      userId,
    ])[0];
    // First connection or mailbox reset: latest 200 UIDs only; later calls advance from the durable cursor.
    let cursor = saved?.uid_validity === validity ? saved.last_uid : Math.max(0, next - 201);
    const mailboxKey = `${config.host}:${config.user}:${config.mailbox}:${validity}`;
    if (cursor < next - 1) {
      for await (const message of client.fetch(
        `${cursor + 1}:*`,
        { uid: true, size: true, source: { start: 0, maxLength: MAX_SOURCE_BYTES + 1 } },
        { uid: true },
      )) {
        if (scanned >= 100) break;
        if (
          SqliteConnection.query('SELECT ciphertext FROM application_mail WHERE user_id=?', [userId])[0]?.ciphertext !==
          savedCiphertext
        )
          throw new Error('Mailbox configuration changed.');
        scanned += 1;
        if (!Number.isSafeInteger(message.uid) || message.uid <= cursor) continue;
        const source = message.source;
        if (message.size <= MAX_SOURCE_BYTES && Buffer.isBuffer(source) && source.length <= MAX_SOURCE_BYTES) {
          const parsed = await (parseMessage || simpleParser)(source, {
            skipHtmlToText: true,
            skipTextToHtml: true,
            skipImageLinks: true,
          });
          if (
            matchReply(
              userId,
              {
                messageId: parsed.messageId,
                inReplyTo: parsed.inReplyTo,
                references: parsed.references,
                subject: parsed.subject,
                text: parsed.text || '(Message has no plain-text body.)',
                from: parsed.from?.text || '',
              },
              mailboxKey,
            )
          )
            matched += 1;
        }
        cursor = Math.max(cursor, message.uid);
        SqliteConnection.execute(
          'UPDATE application_mail SET uid_validity=?,last_uid=? WHERE user_id=? AND ciphertext=?',
          [validity, cursor, userId, savedCiphertext],
        );
      }
    }
    SqliteConnection.execute(
      'UPDATE application_mail SET uid_validity=?,last_uid=?,last_sync_at=?,last_sync_error=NULL WHERE user_id=? AND ciphertext=?',
      [validity, cursor, new Date().toISOString(), userId, savedCiphertext],
    );
    return { matched, scanned };
  } catch {
    SqliteConnection.execute('UPDATE application_mail SET last_sync_error=? WHERE user_id=? AND ciphertext=?', [
      'Inbox synchronization failed. Check connection settings and retry.',
      userId,
      savedCiphertext,
    ]);
    throw new ApplicationError(
      'Inbox synchronization failed. Check connection settings and retry.',
      502,
      'mail_sync_failed',
    );
  } finally {
    clearTimeout(timeout);
    lock?.release();
    try {
      await client?.logout();
    } catch {
      client?.close?.();
    }
    syncing.delete(userId);
  }
}
