/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import db from '../storage/SqliteConnection.js';
import { getJob, getJobs } from '../storage/jobStorage.js';
import { getUserSettings, upsertSettings } from '../storage/settingsStorage.js';
import { getFitProfile } from '../fit/storage.js';
import { ApplicationError } from '../applications/storage.js';
import { sniffAttachmentMime, sanitizeAttachmentName } from '../listings/attachmentTypes.js';
import { sendToUser } from '../sse/sse-broker.js';

export const PORTALS = [
  { id: 'immoscout', name: 'ImmoScout24' },
  { id: 'immowelt', name: 'Immowelt' },
  { id: 'kleinanzeigen', name: 'Kleinanzeigen' },
];
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const parse = (value, fallback = null) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};
export const fail = (message, status = 400) => {
  throw new ApplicationError(message, status);
};
export const changed = (userId) => sendToUser(userId, 'auto-apply', { changed: true });
const docColumns = 'id,filename,description,mime_type AS mimeType,size,hash,created_at AS createdAt';

/** Persistent switch is shared by the API, background queue and deployment process. */
export function isDraining() {
  return db.query('SELECT draining FROM auto_apply_control WHERE id=1')[0]?.draining === 1;
}
export function setDraining(value) {
  db.execute('UPDATE auto_apply_control SET draining=? WHERE id=1', [value ? 1 : 0]);
}
export function ruleFor(userId, jobId) {
  const row = db.query('SELECT * FROM auto_apply_rules WHERE user_id=? AND job_id=?', [userId, jobId])[0];
  return row
    ? {
        ...parse(row.config, {}),
        userId,
        jobId,
        enabled: !!row.enabled,
        generation: row.generation,
        since: row.since,
        revision: row.revision,
      }
    : null;
}
export function connectionFor(userId, id) {
  const row = db.query(
    'SELECT id,user_id AS userId,portal,mode,name,control_mode AS controlMode,status,account_identity AS accountIdentity,qualified,last_seen AS lastSeen,revoked FROM auto_apply_connections WHERE user_id=? AND id=?',
    [userId, id],
  )[0];
  if (!row || row.revoked) fail('Browser connection not found.', 404);
  return { ...row, qualified: !!row.qualified };
}
export function modelConfig(userId) {
  const config = getUserSettings(userId)?.autoApplyModel ?? {};
  return { model: typeof config.model === 'string' ? config.model : '', checked: config.checked === true };
}
export function saveModel(userId, model, checked = false) {
  if (typeof model !== 'string' || !/^[\w./:-]{1,160}$/.test(model)) fail('Choose a valid browser-agent model.');
  upsertSettings({ autoApplyModel: { model, checked } }, userId);
  changed(userId);
  return modelConfig(userId);
}
/** Owner-only rules never borrow a shared job's applicant or rating. */
export function saveRule(userId, jobId, input) {
  const job = getJob(jobId);
  if (!job || job.userId !== userId) fail('Search not found or not owned.', 404);
  if (!input || typeof input.enabled !== 'boolean') fail('Specify whether auto-apply is enabled.');
  const minimumScore = input.minimumScore ?? 8;
  if (
    !Number.isFinite(minimumScore) ||
    minimumScore < 0 ||
    minimumScore > 10 ||
    Math.abs(minimumScore * 10 - Math.round(minimumScore * 10)) > 1e-8
  )
    fail('Minimum score must be 0–10 in steps of 0.1.');
  const portals = input.portals ?? [];
  if (!Array.isArray(portals) || portals.length > 3 || portals.some((p) => !PORTALS.some(({ id }) => id === p)))
    fail('Choose supported portals.');
  const documentIds = input.documentIds ?? [];
  if (!Array.isArray(documentIds) || documentIds.length > 10 || documentIds.some((id) => typeof id !== 'string'))
    fail('Select at most ten applicant documents.');
  for (const id of documentIds) documentFor(userId, id);
  const connectionIds = {};
  for (const portal of portals) {
    const id = input.connectionIds?.[portal];
    if (!id && !input.enabled) continue;
    const connection = connectionFor(userId, id);
    if (connection.portal !== portal) fail('Browser connection does not match the portal.');
    if (input.enabled && (!connection.qualified || !connection.accountIdentity))
      fail('Connect and qualify each portal login before enabling auto-apply.');
    connectionIds[portal] = id;
  }
  if (input.enabled && (!portals.length || !modelConfig(userId).checked || !getFitProfile(userId).criteria.length))
    fail('Choose portals, configure the browser model, and save apartment requirements first.');
  const previous = ruleFor(userId, jobId);
  const newlyEnabled = input.enabled && !previous?.enabled;
  const generation = newlyEnabled || !previous ? nanoid() : previous.generation;
  const since = newlyEnabled || !previous ? Date.now() : previous.since;
  const config = JSON.stringify({
    minimumScore,
    portals: [...new Set(portals)],
    documentIds: [...new Set(documentIds)],
    connectionIds,
  });
  db.withTransaction(() => {
    db.execute(
      `INSERT INTO auto_apply_rules(user_id,job_id,enabled,generation,since,config) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,job_id) DO UPDATE SET enabled=excluded.enabled,generation=excluded.generation,since=excluded.since,config=excluded.config,revision=revision+1`,
      [userId, jobId, input.enabled ? 1 : 0, generation, since, config],
    );
    if (!input.enabled)
      db.execute(
        "UPDATE auto_apply_runs SET state=CASE WHEN state='submitting' THEN 'uncertain' ELSE 'cancelled' END,reason='rule_disabled',updated_at=? WHERE user_id=? AND job_id=? AND state IN ('pending_assessment','queued','running','needs_input','submitting')",
        [Date.now(), userId, jobId],
      );
  });
  changed(userId);
  return ruleFor(userId, jobId);
}
/** Tokens are shown once; only their digest is persisted. */
export function createConnection(userId, input) {
  if (!PORTALS.some(({ id }) => id === input?.portal) || !['server', 'desktop'].includes(input?.mode))
    fail('Choose a portal and browser mode.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    fail('Name the browser connection.');
  const id = nanoid(),
    token = randomBytes(32).toString('base64url');
  db.execute(
    'INSERT INTO auto_apply_connections(id,user_id,portal,mode,name,token_hash,created_at) VALUES(?,?,?,?,?,?,?)',
    [id, userId, input.portal, input.mode, input.name.trim(), hash(token), Date.now()],
  );
  return { connection: connectionFor(userId, id), token };
}
export function authenticateWorker(token) {
  if (typeof token !== 'string' || token.length > 200) fail('Invalid worker credential.', 401);
  const row = db.query('SELECT id,user_id FROM auto_apply_connections WHERE token_hash=? AND revoked=0', [
    hash(token),
  ])[0];
  if (!row) fail('Invalid worker credential.', 401);
  return connectionFor(row.user_id, row.id);
}
export function listDocuments(userId) {
  return db.query(`SELECT ${docColumns} FROM applicant_documents WHERE user_id=? ORDER BY created_at`, [userId]);
}
export function documentFor(userId, id, bytes = false) {
  const doc = db.query(
    `SELECT ${docColumns}${bytes ? ',content' : ''} FROM applicant_documents WHERE user_id=? AND id=?`,
    [userId, id],
  )[0];
  if (!doc) fail('Applicant document not found.', 404);
  return doc;
}
/** Normalize plain private notes; explanations never become portal instructions or message text. */
function documentDescription(value) {
  if (typeof value !== 'string' || value.length > 2000)
    fail('Document explanation must be text of at most 2,000 characters.');
  return value.trim();
}
/** Update only owner-authored metadata, preserving bytes, hashes and historical receipts. */
export function updateDocument(userId, id, { description } = {}) {
  documentFor(userId, id);
  const note = documentDescription(description);
  db.execute('UPDATE applicant_documents SET description=? WHERE user_id=? AND id=?', [note, userId, id]);
  changed(userId);
  return documentFor(userId, id);
}
/** Keep bytes in the backed-up database, sniff content, and bound aggregate storage per user. */
export function addDocument(userId, { filename, contentBase64, description = '' } = {}) {
  const note = documentDescription(description);
  if (
    typeof contentBase64 !== 'string' ||
    contentBase64.length > 14_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
  )
    fail('Upload a PDF, JPEG or PNG up to 10 MB.');
  const content = Buffer.from(contentBase64, 'base64');
  const mimeType = sniffAttachmentMime(content);
  if (!mimeType || !content.length || content.length > 10 * 1024 * 1024) fail('Upload a PDF, JPEG or PNG up to 10 MB.');
  const docs = listDocuments(userId);
  if (docs.length >= 20 || docs.reduce((sum, d) => sum + d.size, 0) + content.length > 100 * 1024 * 1024)
    fail('Applicant document storage limit reached (20 files / 100 MB).');
  const id = nanoid();
  db.execute(
    'INSERT INTO applicant_documents(id,user_id,filename,mime_type,size,hash,created_at,content,description) VALUES(?,?,?,?,?,?,?,?,?)',
    [
      id,
      userId,
      sanitizeAttachmentName(filename, mimeType),
      mimeType,
      content.length,
      hash(content),
      Date.now(),
      content,
      note,
    ],
  );
  changed(userId);
  return documentFor(userId, id);
}
export function removeDocument(userId, id) {
  documentFor(userId, id);
  db.execute('DELETE FROM applicant_documents WHERE user_id=? AND id=?', [userId, id]);
  changed(userId);
}
export function serializeRun(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    listingId: row.listing_id,
    jobId: row.job_id,
    portal: row.portal,
    origin: row.origin,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshot: parse(row.snapshot),
    receipt: parse(row.receipt),
    usage: parse(row.usage),
  };
}
export function runFor(userId, id) {
  const row = db.query('SELECT * FROM auto_apply_runs WHERE user_id=? AND id=?', [userId, id])[0];
  if (!row) fail('Application run not found.', 404);
  return row;
}
export function overview(userId) {
  return {
    rules: db
      .query('SELECT job_id FROM auto_apply_rules WHERE user_id=?', [userId])
      .map((r) => ruleFor(userId, r.job_id)),
    runs: db
      .query('SELECT * FROM auto_apply_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 200', [userId])
      .map(serializeRun),
    connections: db
      .query('SELECT id FROM auto_apply_connections WHERE user_id=? AND revoked=0', [userId])
      .map((r) => connectionFor(userId, r.id)),
    documents: listDocuments(userId),
    model: modelConfig(userId),
    jobs: getJobs({ includeDisabled: true, visibleTo: { id: userId, isAdmin: false } })
      .filter((j) => j.userId === userId)
      .map((j) => ({ id: j.id, name: j.name })),
    portals: PORTALS,
    draining: isDraining(),
  };
}
