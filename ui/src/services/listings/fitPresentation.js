/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Shared fit tone for cards and pins, on the same rounded display scale. Missing scores are
 * unassessed; required failures override scores, and stale/unknown results never appear green.
 * @param {{score: number, hardFailure?: boolean, hardUnknown?: boolean, stale?: boolean}|null} summary
 * @returns {'unassessed'|'low'|'medium'|'high'}
 */
export function fitTone(summary) {
  if (!summary || !Number.isFinite(summary.score)) return 'unassessed';
  const score = Math.round(Math.max(0, Math.min(100, summary.score))) / 10;
  return summary.hardFailure || score < 5
    ? 'low'
    : summary.stale || summary.hardUnknown || score < 8
      ? 'medium'
      : 'high';
}
