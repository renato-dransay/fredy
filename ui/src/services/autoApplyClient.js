/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { xhrDelete, xhrGet, xhrPost, xhrPut } from './xhr.js';

const ROOT = '/api/applications/auto-apply';
const resource = (kind, id) => `${ROOT}/${kind}/${encodeURIComponent(id)}`;

/** Read only the signed-in user's rules, private browser connections, runs and document metadata. */
export async function loadAutoApply() {
  return (await xhrGet(ROOT)).json;
}

/** Store a search owner's explicit assessment and automatic-submission authorization. */
export async function saveAutoApplyRule(jobId, rule) {
  return (await xhrPut(resource('rules', jobId), rule)).json;
}

/** Pair an isolated worker; the returned credential is shown once and never cached by the UI. */
export async function connectAutoApplyBrowser(connection) {
  return (await xhrPost(`${ROOT}/connections`, connection)).json;
}

/** Request human takeover, release, pause, or revocation of a browser connection. */
export async function controlAutoApplyBrowser(id, action) {
  return (await xhrPost(`${resource('connections', id)}/control`, { action })).json;
}

/** Frames stay behind Fredy's session authentication; no raw CDP/viewer URLs are exposed. */
export async function autoApplyBrowserFrame(id) {
  return (await xhrGet(`${resource('connections', id)}/frame`)).json;
}

/** Send a human action only to the selected private browser. */
export async function autoApplyBrowserInput(id, input) {
  return (await xhrPost(`${resource('connections', id)}/input`, input)).json;
}

/** Control execution state without changing the manually managed application lifecycle. */
export async function controlAutoApplyRun(id, action, details = {}) {
  return (await xhrPost(`${resource('runs', id)}/control`, { ...details, action })).json;
}

/** Save the browser-agent model separately from the assessment model. */
export async function saveAutoApplyModel(model) {
  return (await xhrPut(`${ROOT}/model`, { model })).json;
}

/** Explicitly make a small inference request to verify the selected model and credential. */
export async function checkAutoApplyModel() {
  return (await xhrPost(`${ROOT}/model/check`, {})).json;
}

/** Read an applicant file for an authenticated upload; the server validates type and size again. */
export async function uploadApplicantDocument(file, description = '') {
  if (!file || file.size === 0 || file.size > 10 * 1024 * 1024) throw new Error('Choose a file of 1 byte to 10 MB.');
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
  return (await xhrPost(`${ROOT}/documents`, { filename: file.name, contentBase64, description })).json;
}

/** Save a private explanation without replacing the uploaded document. */
export async function updateApplicantDocument(id, description) {
  return (await xhrPut(resource('documents', id), { description })).json;
}

/** Remove a private applicant document; the server invalidates any affected queued work. */
export async function deleteApplicantDocument(id) {
  return (await xhrDelete(resource('documents', id))).json;
}

/** Downloads recheck the signed-in user's ownership. */
export function applicantDocumentUrl(id) {
  return resource('documents', id);
}
