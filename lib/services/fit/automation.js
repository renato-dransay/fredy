/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getJob } from '../storage/jobStorage.js';
import { getSettings, getUserSettings, upsertSettings } from '../storage/settingsStorage.js';
import { getListingById } from '../storage/listingsStorage.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { getFitProfile, getFitResult } from './storage.js';
import { isFitStale } from './evaluate.js';
import { evaluateStoredFit, FitEvaluationError } from './evaluationService.js';
import { FitProviderError } from './jev.js';
import logger from '../logger.js';

const SETTING = 'automaticFitJobs';
const COOLDOWN = 'automaticFitCooldowns';
const BATCH_SIZE = 20;

/** Read explicit per-job opt-ins; a profile alone never authorizes automatic paid calls. */
export function automaticFitJobs(userId) {
  const value = getUserSettings(userId)?.[SETTING];
  return Array.isArray(value)
    ? value.filter((item) => typeof item?.jobId === 'string' && Number.isFinite(item.since) && item.since > 0)
    : [];
}

/** Save only owned jobs, preserving activation time for unchanged selections. */
export function saveAutomaticFitJobs(userId, jobIds) {
  if (!Array.isArray(jobIds) || jobIds.length > 100 || jobIds.some((id) => typeof id !== 'string'))
    throw new Error('Choose at most 100 owned jobs.');
  const ids = [...new Set(jobIds)];
  if (ids.some((id) => getJob(id)?.userId !== userId)) throw new Error('Choose only jobs you own.');
  const existing = new Map(automaticFitJobs(userId).map((item) => [item.jobId, item]));
  const value = ids.map((jobId) => existing.get(jobId) ?? { jobId, since: Date.now() });
  upsertSettings({ [SETTING]: value }, userId);
  return value;
}

/** Resolve a current enabled opt-in and refuse demo-mode background inference. */
async function contextFor(jobId) {
  const job = getJob(jobId);
  if (!job?.enabled || !job.userId || (await getSettings()).demoMode) return null;
  const optIn = automaticFitJobs(job.userId).find((item) => item.jobId === job.id);
  if (!optIn || !getFitProfile(job.userId).criteria.length) return null;
  const cooldowns = getUserSettings(job.userId)[COOLDOWN] ?? {};
  return { job, optIn, coolingDown: Number(cooldowns[job.id]) > Date.now() };
}

/**
 * Assess at most twenty new candidates per batch, retaining all rows on failure. Four workers
 * share the same global guard as manual evaluations. Missing/failed calls remain eligible for
 * the next scheduled batch; an outage backs off this job for fifteen minutes, including restarts.
 * @param {string} jobId
 * @param {Array<{id:string}>} listings
 * @returns {Promise<void>}
 */
export async function assessAutomaticListings(jobId, listings) {
  const context = await contextFor(jobId);
  if (!context || context.coolingDown) return;
  const { job, optIn } = context;
  let outage = false;
  const selected = listings.slice(0, BATCH_SIZE);
  for (let offset = 0; offset < selected.length && !outage; offset += 4) {
    const latest = await contextFor(jobId);
    if (!latest || latest.coolingDown || latest.job.userId !== job.userId || latest.optIn.since !== optIn.since) break;
    await Promise.all(
      selected.slice(offset, offset + 4).map(async ({ id }) => {
        try {
          const resolve = () => {
            const latestJob = getJob(job.id);
            if (latestJob?.userId !== job.userId || !latestJob.enabled) return null;
            if (!automaticFitJobs(job.userId).some((item) => item.jobId === job.id && item.since === optIn.since))
              return null;
            const listing = getListingById(id, job.userId, false);
            return listing?.job_id === job.id &&
              listing.created_at >= optIn.since &&
              latestJob.provider?.some((source) => source.id === listing.provider && source.enabled !== false) &&
              listing.is_active &&
              !listing.manually_deleted
              ? listing
              : null;
          };
          if (!resolve() || getFitResult(job.userId, id)) return;
          await evaluateStoredFit(job.userId, id, resolve);
        } catch (error) {
          if (error instanceof FitProviderError) outage = true;
          else if (!(error instanceof FitEvaluationError)) logger.warn('Automatic fit unavailable for a candidate.');
        }
      }),
    );
  }
  if (outage) {
    const cooldowns = getUserSettings(job.userId)[COOLDOWN] ?? {};
    upsertSettings({ [COOLDOWN]: { ...cooldowns, [job.id]: Date.now() + 15 * 60_000 } }, job.userId);
  }
}

/**
 * Recover unassessed new candidates on later ticks, including after a restart. The activation
 * cutoff excludes historical inventory; existing assessments are never automatically repurchased.
 * @param {string} jobId
 * @returns {Promise<void>}
 */
export async function drainAutomaticFit(jobId) {
  const context = await contextFor(jobId);
  if (!context || context.coolingDown) return;
  const { job, optIn } = context;
  const sourceIds = (job.provider ?? []).filter((source) => source.enabled !== false).map((p) => p.id);
  if (!sourceIds.length) return;
  const rows = SqliteConnection.query(
    `SELECT l.id FROM listings l
     WHERE l.job_id = ? AND l.created_at >= ? AND l.is_active = 1 AND l.manually_deleted = 0
       AND l.provider IN (${sourceIds.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM apartment_fit_results r WHERE r.user_id = ? AND r.listing_id = l.id)
     ORDER BY l.created_at, l.id LIMIT 20`,
    [job.id, optIn.since, ...sourceIds, job.userId],
  );
  await assessAutomaticListings(job.id, rows);
}

/** Return only a generic notification category, never private criteria, reasons or evidence. */
export function automaticFitStatus(jobId, listingId) {
  const job = getJob(jobId);
  if (!job?.userId || !automaticFitJobs(job.userId).some((item) => item.jobId === job.id)) return null;
  const result = getFitResult(job.userId, listingId);
  if (!result) {
    const cooldowns = getUserSettings(job.userId)[COOLDOWN] ?? {};
    return Number(cooldowns[job.id]) > Date.now() ? 'unavailable' : 'pending';
  }
  const listing = getListingById(listingId, job.userId, false);
  if (!listing || isFitStale(result, getFitProfile(job.userId), listing)) return 'pending';
  return result.hardFailure ? 'failed' : result.hardUnknown ? 'unknown' : 'matched';
}
