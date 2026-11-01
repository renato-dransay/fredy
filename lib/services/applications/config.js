/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';

/** A persistent volume holds the encryption key; missing/corrupt keys never silently replace saved secrets. */
function masterKey() {
  const file = process.env.FREDY_MAIL_KEY_FILE || path.resolve('conf/application-mail.key');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const rows = SqliteConnection.query('SELECT user_id FROM application_mail LIMIT 1');
    if (rows.length) throw new Error('Mail encryption key unavailable. Restore the configuration backup.');
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Mail encryption key unavailable.');
    }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('Mail encryption key requires private file permissions.');
  const value = fs.readFileSync(file);
  if (value.length !== 32) throw new Error('Mail encryption key is invalid. Restore the configuration backup.');
  return value;
}

/** Read private connection credentials only inside the server-side transport boundary. */
export function readMailSecrets(userId) {
  const row = SqliteConnection.query('SELECT * FROM application_mail WHERE user_id = ?', [userId])[0];
  if (!row) return {};
  try {
    const [iv, tag, data] = row.ciphertext.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Saved mail credentials could not be decrypted. Restore the configuration backup.');
  }
}

/** A strict single mailbox protects the message envelope and forbids header/address-list injection. */
export function validEmail(value) {
  return (
    typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(value)
  );
}

/** Serialize configuration without returning any password, encrypted bytes, or mailbox internals. */
export function publicMailConfig(userId) {
  const value = readMailSecrets(userId);
  const row = SqliteConnection.query('SELECT last_sync_at, last_sync_error FROM application_mail WHERE user_id = ?', [
    userId,
  ])[0];
  const result = {};
  for (const type of ['smtp', 'imap']) {
    const { password, ...config } = value[type] || {};
    result[type] = {
      ...config,
      configured: Boolean(config.host && config.user && password && (type !== 'smtp' || validEmail(config.from))),
      passwordSet: Boolean(password),
    };
  }
  return { ...result, lastSyncAt: row?.last_sync_at || null, lastSyncError: row?.last_sync_error || null };
}

/** Update only the selected user's connection settings; omitted passwords retain, null clears. */
export function saveMailConfig(userId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Mail configuration must be an object.');
  const value = readMailSecrets(userId);
  let resetCursor = false;
  for (const type of ['smtp', 'imap']) {
    if (patch[type] === undefined) continue;
    const input = patch[type];
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Connection settings must be an object.');
    const next = { ...(value[type] || {}) };
    for (const key of ['host', 'user', ...(type === 'smtp' ? ['from'] : ['mailbox'])]) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'string' || input[key].length > 254 || /[\r\n\0]/.test(input[key]))
        throw new Error(`Invalid mail ${key}.`);
      next[key] = input[key].trim();
    }
    if (next.host && !/^[a-zA-Z0-9.-]+$/.test(next.host)) throw new Error('Mail host must be a hostname.');
    if (next.from && !validEmail(next.from)) throw new Error('Mail from must be one email address.');
    if (input.port !== undefined) {
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
        throw new Error('Mail port must be 1–65535.');
      next.port = input.port;
    }
    next.port ||= type === 'smtp' ? 587 : 993;
    if (type === 'smtp') {
      if (input.secure !== undefined && typeof input.secure !== 'boolean')
        throw new Error('SMTP secure must be a boolean.');
      next.secure = input.secure ?? next.secure ?? next.port === 465;
    } else next.mailbox ||= 'INBOX';
    if (input.password !== undefined) {
      if (input.password !== null && (typeof input.password !== 'string' || input.password.length > 4096))
        throw new Error('Invalid mail password.');
      next.password = input.password || null;
    }
    if (
      type === 'imap' &&
      ['host', 'user', 'mailbox', 'password', 'port'].some((key) => next[key] !== value.imap?.[key])
    )
      resetCursor = true;
    value[type] = next;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const ciphertext = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
  SqliteConnection.execute(
    `INSERT INTO application_mail(user_id,ciphertext) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext`,
    [userId, ciphertext],
  );
  if (resetCursor)
    SqliteConnection.execute(
      'UPDATE application_mail SET uid_validity=NULL,last_uid=0,last_sync_error=NULL WHERE user_id=?',
      [userId],
    );
  return publicMailConfig(userId);
}
