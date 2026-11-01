/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Resolve the operator's personal credential. Saved settings override the deployment fallback;
 * the shared OPENROUTER_API_KEY is deliberately never consulted. Keep apiKey server-side.
 * @param {Record<string, any>} settings
 * @returns {{apiKey: string, source: 'settings'|'environment'|null}}
 */
export function openRouterConfig(settings) {
  const saved = settings.openrouterApiKey;
  if (typeof saved === 'string' && saved.trim()) return { apiKey: saved.trim(), source: 'settings' };
  const fallback = process.env.OPENROUTER_API_KEY_PERSONAL?.trim();
  return { apiKey: fallback || '', source: fallback ? 'environment' : null };
}

/**
 * Normalize the write-only field before any settings are stored. Empty/omitted retains, null
 * removes the saved key. Error messages never include the submitted value.
 * @param {Record<string, any>} incoming Settings patch, normalized in place.
 * @returns {string|null} Validation error, if any.
 */
export function prepareOpenRouterSettings(incoming) {
  const value = incoming.openrouterApiKey;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 4096) return 'Invalid personal OpenRouter API key.';
  const key = value.trim();
  // A credential is an HTTP header value, so embedded control characters must be rejected.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(key)) return 'Invalid personal OpenRouter API key.';
  if (key) incoming.openrouterApiKey = key;
  else delete incoming.openrouterApiKey;
  return null;
}
