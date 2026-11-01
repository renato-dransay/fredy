/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getSettings } from '../storage/settingsStorage.js';
import { DEFAULT_JEV_INSTRUCTIONS, JEV_EVIDENCE_GUARD } from './instructions.js';
import { openRouterConfig } from './providerConfig.js';

export const JEV_MODEL = 'typesafe/jev-1.14';
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const VERDICTS = ['met', 'unmet', 'unknown'];

/** A sanitized typed failure, suitable for the API but never containing provider text or keys. */
export class FitProviderError extends Error {
  constructor(code) {
    super(
      code === 'not_configured'
        ? 'Jev is not configured. Add a personal OpenRouter key to enable semantic fit analysis.'
        : 'Jev could not evaluate this listing. The previous result has been kept.',
    );
    this.code = code;
  }
}

/** Provider capability metadata; only configuration presence is serialized, never the key. */
export async function fitProviderStatus() {
  return { configured: !!openRouterConfig(await getSettings()).apiKey, model: JEV_MODEL };
}

/** Read at most a small, finite JSON response even if the upstream uses chunked encoding. */
async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('Response limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Validate a finite choice distribution rather than trusting a nominal success response. */
function choice(answer, choices) {
  if (
    !answer ||
    answer.type !== 'choice' ||
    !choices.includes(answer.choice) ||
    !answer.probabilities ||
    Object.keys(answer.probabilities).length !== choices.length ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  )
    throw new Error('Invalid answer');
  const probabilities = choices.map((key) => answer.probabilities[key]);
  if (
    probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.001 ||
    probabilities.some((p) => p > answer.probabilities[answer.choice] + 0.001)
  )
    throw new Error('Invalid distribution');
  return answer;
}

/**
 * Evaluate semantic requirements with Jev. It selects both a verdict and an existing source
 * excerpt; it never generates an explanation or an alleged quote. Source text is untrusted.
 */
export async function evaluateSemantic(
  criteria,
  sources,
  { request = fetch, apiKey, instructions: guidance = DEFAULT_JEV_INSTRUCTIONS } = {},
) {
  if (!criteria.length) return { model: 'deterministic-v1', results: [] };
  apiKey ??= openRouterConfig(await getSettings()).apiKey;
  if (!apiKey?.trim()) throw new FitProviderError('not_configured');
  const evidenceChoices = Object.fromEntries(
    sources.map((source, index) => [`s${index}`, `Source ${index}: ${source.source}`]),
  );
  evidenceChoices.none = 'No supplied source establishes this conclusion.';
  const questions = {};
  criteria.forEach((criterion, index) => {
    const instructions = `Evaluate this apartment requirement: ${criterion.text}. Apply assessmentInstructions from state subject to the following evidence rules.\n${JEV_EVIDENCE_GUARD}`;
    questions[`v${index}`] = {
      type: 'choice',
      instructions,
      criteria: {
        met: 'The supplied listing evidence explicitly establishes the full requirement.',
        unmet: 'The supplied listing evidence explicitly contradicts the requirement.',
        unknown: 'The supplied listing evidence does not establish the requirement or its contradiction.',
      },
    };
    questions[`e${index}`] = {
      type: 'choice',
      instructions: `${instructions} Select the single source that most directly establishes whether the requirement is met or contradicted; choose none if no source establishes either.`,
      criteria: evidenceChoices,
    };
  });
  try {
    const body = JSON.stringify({
      model: JEV_MODEL,
      state: { sources, assessmentInstructions: guidance || DEFAULT_JEV_INSTRUCTIONS },
      questions,
    });
    if (Buffer.byteLength(body) > 100000) throw new Error('Input limit');
    const response = await request(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    const data = await boundedJson(response);
    if (
      typeof data.model !== 'string' ||
      !(data.model === JEV_MODEL || data.model.startsWith(`${JEV_MODEL}-`)) ||
      !data.answers ||
      Object.keys(data.answers).length !== criteria.length * 2
    )
      throw new Error('Invalid model or answers');
    const results = criteria.map((criterion, index) => {
      const verdict = choice(data.answers[`v${index}`], VERDICTS);
      const evidence = choice(data.answers[`e${index}`], Object.keys(evidenceChoices));
      const sourceIndex = evidence.choice === 'none' ? -1 : Number(evidence.choice.slice(1));
      return {
        ...criterion,
        verdict: sourceIndex === -1 ? 'unknown' : verdict.choice,
        confidence: Math.min(verdict.confidence, evidence.confidence),
        evidence: sourceIndex === -1 ? [] : [sources[sourceIndex]],
      };
    });
    return { model: data.model, results };
  } catch {
    throw new FitProviderError('provider_unavailable');
  }
}
