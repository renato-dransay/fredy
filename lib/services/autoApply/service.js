/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { randomBytes } from 'node:crypto';
import db from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import {
  getListingById,
  userCanAccessListing,
  applyMarketBenchmark,
  applyScamSignals,
  attachTravelTimes,
} from '../storage/listingsStorage.js';
import { getSettings, getUserSettings, getAddresses } from '../storage/settingsStorage.js';
import { searchEligibility } from '../listings/searchEligibility.js';
import { scamVerdict } from '../listings/scamSignals.js';
import { updateTravelTimesForListings } from '../listings/travelTimeSweeper.js';
import { addressesWithBudget, exceedsCommuteBudget, normalizeCommuteFilter } from '../../utils/commuteBudget.js';
import { getFitProfile, getFitResult } from '../fit/storage.js';
import { isFitStale } from '../fit/evaluate.js';
import { evaluateStoredFit } from '../fit/evaluationService.js';
import { buildApplicationLetter } from '../application/applicationService.js';
import { applicationRow, saveApplication, addEvent } from '../applications/storage.js';
import { buildFingerprint, isLikelyDuplicate } from '../similarity-check/listingFingerprint.js';
import { isDeploymentActive } from '../deploymentGate.js';
import { canonicalAdvert, verifyConfirmation } from './portals.js';
import {
  changed,
  fail,
  hash,
  parse,
  ruleFor,
  connectionFor,
  documentFor,
  runFor,
  isDraining,
  modelConfig,
} from './storage.js';
import logger from '../logger.js';

const ACTIVE = ['running', 'submitting'];
const LEASE_MS = 30000;
const MAX_MS = 600000;

/** Freeze only applicant-authored inputs; edits revoke an in-flight prepared application. */
function applicantRevision(userId, listingId) {
  const settings = getUserSettings(userId) ?? {};
  return hash(
    JSON.stringify({
      profile: settings.applicant_profile ?? {},
      templates: settings.application_templates ?? {},
      language: settings.language ?? null,
      draft: applicationRow(userId, listingId)?.body ?? '',
    }),
  );
}

/** All state changes use persisted rows; a restart never clears an uncertain send. */
function transition(run, state, reason = null) {
  db.execute('UPDATE auto_apply_runs SET state=?,reason=?,updated_at=? WHERE id=? AND state=?', [
    state,
    reason,
    Date.now(),
    run.id,
    run.state,
  ]);
  changed(run.user_id);
}
export async function operational() {
  return isDeploymentActive() && !isDraining() && !(await getSettings()).demoMode;
}
/** Resolve only the owning user's current state, including exact search exclusions. */
export function eligibility(run, requireScore = true) {
  const rule = ruleFor(run.user_id, run.job_id);
  const job = getJob(run.job_id);
  if (!rule?.enabled || rule.generation !== run.generation || job?.userId !== run.user_id || !job.enabled)
    return { reason: 'rule_disabled' };
  if (!rule.portals.includes(run.portal) || !job.provider?.some((p) => p.id === run.portal && p.enabled !== false))
    return { reason: 'portal_disabled' };
  if (!run.listing_id || !userCanAccessListing(run.listing_id, run.user_id)) return { reason: 'listing_unavailable' };
  const listing = getListingById(run.listing_id, run.user_id, false);
  if (!listing || listing.job_id !== run.job_id || !listing.is_active || listing.manually_deleted)
    return { reason: 'listing_unavailable' };
  const area = searchEligibility(listing, job);
  if (area.state === 'excluded' || area.reason === 'invalid_area') return { reason: area.reason || 'excluded' };
  const { minRooms, minSize, maxPrice } = job.specFilter ?? {};
  if (
    (minRooms && listing.rooms != null && listing.rooms < minRooms) ||
    (minSize && listing.size != null && listing.size < minSize) ||
    (maxPrice && listing.price != null && listing.price > maxPrice)
  )
    return { reason: 'search_specs' };
  const text = `${listing.title ?? ''}\n${listing.description ?? ''}`.toLowerCase();
  if (
    job.blacklist?.some((word) => typeof word === 'string' && word.trim() && text.includes(word.toLowerCase().trim()))
  )
    return { reason: 'blacklist' };
  if (scamVerdict(listing.scam_signals, listing.scam_override).suspicious) return { reason: 'scam' };
  const commute = normalizeCommuteFilter(job.commuteFilter);
  attachTravelTimes([listing]);
  if (
    commute?.action === 'exclude' &&
    exceedsCommuteBudget(listing.travelTimes, addressesWithBudget(getAddresses(getUserSettings(run.user_id)), commute))
  )
    return { reason: 'commute_excluded' };
  const app = applicationRow(run.user_id, run.listing_id);
  if (app && app.status !== 'draft') return { reason: 'application_exists' };
  const advertKey = canonicalAdvert(run.portal, listing.link);
  if (!advertKey) return { reason: 'unsupported_advert' };
  const receipt = db.query('SELECT run_id FROM auto_apply_receipts WHERE user_id=? AND advert_key=?', [
    run.user_id,
    advertKey,
  ])[0];
  if (receipt && receipt.run_id !== run.id) return { reason: 'already_attempted' };
  const fit = getFitResult(run.user_id, run.listing_id);
  if (requireScore && (!fit || isFitStale(fit, getFitProfile(run.user_id), listing)))
    return { reason: 'assessment_required' };
  if (requireScore && (!Number.isFinite(fit.score) || fit.score < rule.minimumScore * 10 || fit.hardFailure))
    return { reason: fit.hardFailure ? 'must_have_failed' : 'below_threshold' };
  return { rule, job, listing, fit, advertKey };
}
/** Cross-search/portal history is private; compare retained facts even after listing deletion. */
function duplicateReason(run, listing, advertKey) {
  const prior = db.query(
    "SELECT id,advert_key,snapshot FROM auto_apply_runs WHERE user_id=? AND id<>? AND state IN ('running','submitting','submitted','uncertain')",
    [run.user_id, run.id],
  );
  const current = buildFingerprint({ ...listing, jobId: run.user_id });
  for (const row of prior) {
    if (row.advert_key === advertKey) return 'already_attempted';
    const other = parse(row.snapshot)?.listing;
    if (!other) continue;
    const fp = buildFingerprint({ ...other, jobId: run.user_id });
    if (isLikelyDuplicate(current, fp)) return 'duplicate_property';
    if (
      current.provider !== fp.provider &&
      current.size != null &&
      current.rooms != null &&
      current.size === fp.size &&
      current.rooms === fp.rooms &&
      current.zip &&
      current.zip === fp.zip
    )
      return 'possible_duplicate';
  }
  const existing = db.query(
    "SELECT l.* FROM application_records a JOIN listings l ON l.id=a.listing_id WHERE a.user_id=? AND a.status<>'draft' AND l.id<>?",
    [run.user_id, run.listing_id],
  );
  for (const other of existing) {
    if (
      canonicalAdvert(other.provider, other.link) === advertKey ||
      isLikelyDuplicate(current, buildFingerprint({ ...other, jobId: run.user_id }))
    )
      return 'application_exists';
  }
  return null;
}
/** Recover leases conservatively: no send-intent row is ever automatically retried. */
export function recoverLeases(now = Date.now()) {
  for (const run of db.query(
    "SELECT * FROM auto_apply_runs WHERE state IN ('running','submitting') AND lease_until<?",
    [now],
  )) {
    if (run.state === 'submitting') transition(run, 'uncertain', 'connection_lost_after_intent');
    else if (run.attempts >= 3) transition(run, 'failed', 'worker_unavailable');
    else {
      transition(run, 'queued', 'retry_before_submission');
      db.execute('UPDATE auto_apply_runs SET available_at=? WHERE id=?', [now + 30000, run.id]);
    }
  }
}
let drainingBatch = false;
/** Independently enrich review-location candidates that never reached the notification tail. */
export async function assessCandidates() {
  if (drainingBatch || !(await operational())) return;
  drainingBatch = true;
  try {
    recoverLeases();
    const rows = db.query(
      "SELECT * FROM auto_apply_runs WHERE state='pending_assessment' AND available_at<=? ORDER BY created_at LIMIT 4",
      [Date.now()],
    );
    for (const run of rows) {
      try {
        if (runFor(run.user_id, run.id).state !== 'pending_assessment') continue;
        let context = eligibility(run, false);
        if (context.reason) {
          transition(run, 'skipped', context.reason);
          continue;
        }
        applyMarketBenchmark(run.job_id, [context.listing]);
        applyScamSignals([context.listing]);
        const addresses = getAddresses(getUserSettings(run.user_id));
        if (addresses.length) await updateTravelTimesForListings([context.listing], addresses);
        if (runFor(run.user_id, run.id).state !== 'pending_assessment') continue;
        context = eligibility(run, false);
        if (context.reason) {
          transition(run, 'skipped', context.reason);
          continue;
        }
        await evaluateStoredFit(run.user_id, run.listing_id, () =>
          runFor(run.user_id, run.id).state === 'pending_assessment' ? (eligibility(run, false).listing ?? null) : null,
        );
        if (!(await operational())) break;
        context = eligibility(run);
        transition(run, context.reason ? 'skipped' : 'queued', context.reason ?? null);
      } catch {
        db.execute('UPDATE auto_apply_runs SET reason=?,available_at=?,updated_at=? WHERE id=? AND state=?', [
          'assessment_unavailable',
          Date.now() + 15 * 60000,
          Date.now(),
          run.id,
          'pending_assessment',
        ]);
      }
    }
  } finally {
    drainingBatch = false;
  }
}
export function startAutoApply() {
  const tick = () => assessCandidates().catch(() => logger.warn('Auto-apply queue unavailable.'));
  void tick();
  const timer = setInterval(tick, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
/** Persist a single global lease; document and letter preparation cannot authorize sending. */
export async function claim(connection) {
  db.execute('UPDATE auto_apply_connections SET last_seen=? WHERE id=?', [Date.now(), connection.id]);
  const current = connectionFor(connection.userId, connection.id);
  const response = { connections: [current], run: null, draining: isDraining() };
  if (
    !(await operational()) ||
    current.controlMode !== 'agent' ||
    !current.qualified ||
    !modelConfig(current.userId).checked
  )
    return response;
  recoverLeases();
  let selected;
  db.withTransaction(() => {
    if (db.query("SELECT id FROM auto_apply_runs WHERE state IN ('running','submitting') LIMIT 1").length) return;
    const rows = db.query(
      "SELECT * FROM auto_apply_runs WHERE user_id=? AND portal=? AND state='queued' AND available_at<=? ORDER BY created_at LIMIT 20",
      [current.userId, current.portal, Date.now()],
    );
    for (const run of rows) {
      const ctx = eligibility(run);
      if (ctx.reason === 'assessment_required') {
        transition(run, 'pending_assessment', ctx.reason);
        continue;
      }
      if (ctx.reason) {
        transition(run, 'skipped', ctx.reason);
        continue;
      }
      if (ctx.rule.connectionIds[run.portal] !== current.id) continue;
      const duplicate = duplicateReason(run, ctx.listing, ctx.advertKey);
      if (duplicate) {
        transition(run, duplicate === 'possible_duplicate' ? 'needs_input' : 'skipped', duplicate);
        continue;
      }
      const leaseToken = randomBytes(24).toString('base64url');
      const snapshot = {
        listing: ctx.listing,
        ruleRevision: ctx.rule.revision,
        fit: ctx.fit,
        accountIdentity: current.accountIdentity,
        startedAt: Date.now(),
      };
      db.execute(
        "UPDATE auto_apply_runs SET state='running',reason=NULL,connection_id=?,lease_token=?,lease_until=?,attempts=attempts+1,advert_key=?,snapshot=?,updated_at=? WHERE id=?",
        [current.id, leaseToken, Date.now() + LEASE_MS, ctx.advertKey, JSON.stringify(snapshot), Date.now(), run.id],
      );
      selected = { run: runFor(current.userId, run.id), ctx, leaseToken };
      break;
    }
  });
  if (!selected) return response;
  try {
    const { run, ctx, leaseToken } = selected;
    const letter = await buildApplicationLetter(ctx.listing, run.user_id);
    if (letter.missing.length || letter.unknown.length) {
      transition(run, 'needs_input', 'applicant_profile_incomplete');
      return response;
    }
    const documents = ctx.rule.documentIds.map((id) => documentFor(run.user_id, id));
    const prior = applicationRow(run.user_id, run.listing_id);
    const message = prior?.body?.trim() || letter.text;
    const profile = getUserSettings(run.user_id)?.applicant_profile ?? {};
    const snapshot = {
      ...parse(run.snapshot),
      message,
      profile,
      documents,
      applicantRevision: applicantRevision(run.user_id, run.listing_id),
    };
    leased(current, run.id, leaseToken, ['running']);
    if (!(await operational())) throw new Error('worker_paused');
    db.execute('UPDATE auto_apply_runs SET snapshot=? WHERE id=?', [JSON.stringify(snapshot), run.id]);
    response.run = {
      id: run.id,
      leaseToken,
      connectionId: current.id,
      accountIdentity: current.accountIdentity,
      portal: run.portal,
      url: ctx.listing.link,
      advertKey: ctx.advertKey,
      letter: message,
      profile,
      documents,
      maxActions: 50,
      maxMs: MAX_MS,
    };
    changed(run.user_id);
    return response;
  } catch {
    transition(selected.run, 'needs_input', 'application_content_unavailable');
    return response;
  }
}
/** A worker token only accesses the run leased to that exact connection. */
export function leased(connection, id, token, states = ACTIVE) {
  const run = runFor(connection.userId, id);
  if (
    run.connection_id !== connection.id ||
    typeof token !== 'string' ||
    run.lease_token !== token ||
    !states.includes(run.state) ||
    run.lease_until < Date.now()
  )
    fail('Application lease expired or revoked.', 409);
  return run;
}
export async function heartbeat(connection, id, token) {
  const run = leased(connection, id, token);
  if (!(await operational()) || connectionFor(connection.userId, connection.id).controlMode !== 'agent') {
    transition(run, run.state === 'submitting' ? 'uncertain' : 'needs_input', 'worker_paused');
    return { active: false };
  }
  const started = parse(run.snapshot)?.startedAt;
  if (!started || Date.now() - started > MAX_MS) {
    transition(run, run.state === 'submitting' ? 'uncertain' : 'failed', 'time_limit');
    return { active: false };
  }
  db.execute('UPDATE auto_apply_runs SET lease_until=? WHERE id=?', [Date.now() + LEASE_MS, id]);
  return { active: true };
}
/** Bind the irreversible boundary to a frozen payload and current user authorization. */
export async function authorize(connection, id, input) {
  if (!(await operational())) fail('Auto-apply is paused.', 409);
  return db.withTransaction(() => {
    const run = leased(connection, id, input.leaseToken, ['running']);
    const ctx = eligibility(run);
    if (ctx.reason) fail(`Application no longer qualifies: ${ctx.reason}`, 409);
    if (!modelConfig(run.user_id).checked) fail('Browser model configuration needs checking.', 409);
    const current = connectionFor(connection.userId, connection.id);
    const snapshot = parse(run.snapshot);
    if (snapshot.applicantRevision !== applicantRevision(run.user_id, run.listing_id))
      fail('Applicant profile or letter changed.', 409);
    if (
      current.controlMode !== 'agent' ||
      !current.qualified ||
      current.id !== ctx.rule.connectionIds[run.portal] ||
      ctx.rule.revision !== snapshot.ruleRevision
    )
      fail('Application settings changed.', 409);
    if (
      input.accountIdentity !== current.accountIdentity ||
      canonicalAdvert(run.portal, input.url) !== ctx.advertKey ||
      input.advertKey !== ctx.advertKey
    )
      fail('Portal account or advert changed.', 409);
    if (
      input.message !== snapshot.message ||
      typeof input.answers !== 'object' ||
      !input.answers ||
      Array.isArray(input.answers) ||
      JSON.stringify(input.answers).length > 20000
    )
      fail('Application content changed.', 409);
    const facts = new Set(
      Object.values(snapshot.profile)
        .filter((v) => v !== undefined && v !== null)
        .map((v) => String(v).trim()),
    );
    for (const value of Object.values(input.answers))
      if (String(value).trim() !== '' && !facts.has(String(value).trim()) && value !== snapshot.message)
        fail('A form answer is not a saved applicant fact.', 409);
    const selected = ctx.rule.documentIds.map((docId) => documentFor(run.user_id, docId));
    const expected = selected.map((d) => `${d.id}:${d.hash}`).sort();
    const sent = (Array.isArray(input.documents) ? input.documents : []).map((d) => `${d.id}:${d.hash}`).sort();
    if (input.attachmentsSupported !== false && JSON.stringify(expected) !== JSON.stringify(sent))
      fail('Selected documents changed or were not attached.', 409);
    if (input.attachmentsSupported === false && sent.length) fail('Invalid attachment receipt.', 409);
    const uploadReceipts = input.uploadReceipts ?? [];
    if (!Array.isArray(uploadReceipts) || uploadReceipts.length > 10) fail('Invalid upload receipts.', 409);
    const uploaded = uploadReceipts.map((receipt) => `${receipt.documentId}:${receipt.hash}`).sort();
    if (
      JSON.stringify(uploaded) !== JSON.stringify(sent) ||
      uploadReceipts.some(
        (receipt) =>
          typeof receipt.attachmentId !== 'string' || !receipt.attachmentId || receipt.attachmentId.length > 256,
      ) ||
      new Set(uploadReceipts.map((receipt) => receipt.attachmentId)).size !== uploadReceipts.length
    )
      fail('Portal upload acceptance is missing or inconsistent.', 409);

    const duplicate = duplicateReason(run, ctx.listing, ctx.advertKey);
    if (duplicate) fail('An application for this property already exists or needs duplicate review.', 409);
    const frozen = {
      ...snapshot,
      message: input.message,
      answers: input.answers,
      documents: selected,
      uploadReceipts,
      attachmentsSupported: input.attachmentsSupported !== false,
      eligibility: {
        score: ctx.fit.score,
        coverage: ctx.fit.coverage,
        ruleRevision: ctx.rule.revision,
        evidenceHash: ctx.fit.evidenceHash,
      },
    };
    const authorization = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10000;
    db.execute(
      "INSERT INTO auto_apply_receipts(user_id,advert_key,run_id,state,snapshot,updated_at) VALUES(?,?,?,'submitting',?,?)",
      [run.user_id, ctx.advertKey, run.id, JSON.stringify(frozen), Date.now()],
    );
    db.execute(
      "UPDATE auto_apply_runs SET state='submitting',snapshot=?,authorization_hash=?,authorization_until=?,consumed=0,updated_at=? WHERE id=?",
      [JSON.stringify(frozen), hash(authorization), expiresAt, Date.now(), id],
    );
    changed(run.user_id);
    return { authorization, expiresAt };
  });
}
/** Single-use check immediately before the guarded network send. */
export async function consume(connection, id, input) {
  if (!(await operational())) fail('Auto-apply is paused.', 409);
  return db.withTransaction(() => {
    const run = leased(connection, id, input.leaseToken, ['submitting']);
    const ctx = eligibility(run);
    const current = connectionFor(connection.userId, connection.id);
    if (
      ctx.reason ||
      current.controlMode !== 'agent' ||
      ctx.rule.revision !== parse(run.snapshot)?.ruleRevision ||
      current.accountIdentity !== parse(run.snapshot)?.accountIdentity ||
      !modelConfig(run.user_id).checked ||
      parse(run.snapshot)?.applicantRevision !== applicantRevision(run.user_id, run.listing_id) ||
      !current.qualified
    )
      fail('Submission authorization revoked.', 409);
    if (
      run.consumed ||
      run.authorization_until < Date.now() ||
      hash(String(input.authorization)) !== run.authorization_hash
    )
      fail('Submission authorization expired or consumed.', 409);
    for (const selected of parse(run.snapshot).documents)
      if (documentFor(run.user_id, selected.id).hash !== selected.hash) fail('Selected document changed.', 409);
    db.execute('UPDATE auto_apply_runs SET consumed=1 WHERE id=?', [id]);
    return { allowed: true };
  });
}
/** Confirmation is tied to the exact advert/account, never just the model's success flag. */
export function reportResult(connection, id, input) {
  const run = runFor(connection.userId, id);
  if (run.connection_id !== connection.id || run.lease_token !== input.leaseToken)
    fail('Application lease revoked.', 409);
  if (run.state === 'submitted') return { state: 'submitted' };
  if (!['running', 'submitting', 'uncertain', 'needs_input', 'cancelled'].includes(run.state))
    fail('Run is no longer active.', 409);
  let state = input.state;
  const snapshot = parse(run.snapshot);
  if (state === 'submitted') {
    if (
      !run.consumed ||
      !verifyConfirmation(run.portal, input.evidence) ||
      input.evidence.advertKey !== run.advert_key ||
      input.evidence.accountIdentity !== snapshot.accountIdentity
    )
      state = 'uncertain';
  } else if (run.authorization_hash) state = 'uncertain';
  else if (!['needs_input', 'failed', 'cancelled'].includes(state)) state = 'failed';
  let reason = typeof input.reason === 'string' && /^[a-z_]{1,100}$/.test(input.reason) ? input.reason : null;
  if (!run.authorization_hash && ['cancelled', 'needs_input'].includes(run.state)) return { state: run.state };
  if (
    state === 'failed' &&
    !run.authorization_hash &&
    run.state === 'running' &&
    run.attempts < 3 &&
    ['browser_operation_failed', 'model_unavailable', 'worker_unavailable'].includes(reason)
  ) {
    state = 'queued';
    reason = 'retry_before_submission';
  }
  db.withTransaction(() => {
    if (state === 'queued')
      db.execute('UPDATE auto_apply_runs SET available_at=? WHERE id=?', [Date.now() + 30000, id]);
    db.execute('UPDATE auto_apply_runs SET state=?,reason=?,receipt=?,updated_at=? WHERE id=?', [
      state,
      reason,
      JSON.stringify(input.evidence ?? null),
      Date.now(),
      id,
    ]);
    if (run.authorization_hash)
      db.execute('UPDATE auto_apply_receipts SET state=?,evidence=?,updated_at=? WHERE user_id=? AND advert_key=?', [
        state,
        JSON.stringify(input.evidence ?? null),
        Date.now(),
        run.user_id,
        run.advert_key,
      ]);
    if (state === 'submitted' && run.listing_id && userCanAccessListing(run.listing_id, run.user_id)) {
      const current = applicationRow(run.user_id, run.listing_id);
      saveApplication(run.user_id, run.listing_id, {
        ...(!current || current.status === 'draft' ? { status: 'submitted' } : {}),
        body: snapshot.message,
      });
      addEvent(
        applicationRow(run.user_id, run.listing_id).id,
        'submitted',
        'Portal confirmed the browser application.',
        'browser',
        `browser:${run.id}`,
      );
    }
  });
  const measured = parse(db.query('SELECT usage FROM auto_apply_runs WHERE id=?', [id])[0]?.usage, {});
  if (Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0) measured.elapsedMs = Math.round(input.elapsedMs);
  if (Number.isInteger(input.actions) && input.actions >= 0 && input.actions <= 50) measured.actions = input.actions;
  db.execute('UPDATE auto_apply_runs SET usage=? WHERE id=?', [JSON.stringify(measured), id]);
  changed(run.user_id);
  return { state };
}
/** Owner intervention cannot convert an ambiguous send into an automatic retry. */
export function controlRun(userId, id, { action, outcome, confirmationText } = {}) {
  const run = runFor(userId, id);
  if (action === 'reconcile') {
    if (
      run.state !== 'uncertain' ||
      !['submitted', 'not_submitted'].includes(outcome) ||
      typeof confirmationText !== 'string' ||
      !confirmationText.trim() ||
      confirmationText.length > 4000
    )
      fail('Inspect portal history and record the result first.');
    db.execute('UPDATE auto_apply_runs SET receipt=? WHERE id=?', [
      JSON.stringify({ manual: true, outcome, confirmationText }),
      run.id,
    ]);
    if (outcome === 'submitted') {
      if (run.listing_id && userCanAccessListing(run.listing_id, userId))
        saveApplication(userId, run.listing_id, { status: 'submitted', body: parse(run.snapshot)?.message ?? '' });
      transition(run, 'submitted', 'manually_reconciled');
      db.execute(
        "UPDATE auto_apply_receipts SET state='submitted',evidence=?,updated_at=? WHERE user_id=? AND advert_key=?",
        [JSON.stringify({ manual: true, confirmationText }), Date.now(), userId, run.advert_key],
      );
    } else {
      // Keep the tombstone. A new explicit user action is needed outside this automation.
      transition(run, 'cancelled', 'confirmed_not_submitted');
      db.execute(
        "UPDATE auto_apply_receipts SET state='cancelled',evidence=?,updated_at=? WHERE user_id=? AND advert_key=?",
        [JSON.stringify({ manual: true, confirmationText }), Date.now(), userId, run.advert_key],
      );
    }
  } else if (action === 'cancel' || action === 'pause') {
    if (['submitted', 'uncertain'].includes(run.state)) fail('Reconcile this application instead.', 409);
    transition(
      run,
      run.authorization_hash ? 'uncertain' : action === 'cancel' ? 'cancelled' : 'needs_input',
      action === 'cancel' ? 'user_cancelled' : 'user_paused',
    );
  } else if (action === 'resume') {
    if (run.state !== 'needs_input' || run.authorization_hash || run.reason === 'possible_duplicate')
      fail('This application cannot be automatically resumed.', 409);
    transition(run, 'pending_assessment');
    db.execute('UPDATE auto_apply_runs SET available_at=? WHERE id=?', [Date.now(), id]);
  } else fail('Unknown application action.');
  return runFor(userId, id);
}
