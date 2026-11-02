/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { xhrGet, xhrPost } from './xhr.js';

const listingPath = (base, id) => `${base}/listings/${encodeURIComponent(id)}`;

/** Read the current user's apartment requirements and provider setup status. */
export async function loadSearchProfile() {
  return (await xhrGet('/api/fit/profile')).json;
}

/** Save the reviewed document and explicit matching criteria. */
export async function saveSearchProfile(profile) {
  return (await xhrPost('/api/fit/profile', profile)).json;
}

/** Read the last assessment without silently initiating a paid provider request. */
export async function loadFit(id) {
  return (await xhrGet(listingPath('/api/fit', id))).json;
}

/** Request a fresh, bounded assessment for this listing. */
export async function evaluateFit(id) {
  return (await xhrPost(`${listingPath('/api/fit', id)}/evaluate`, {})).json;
}

/** Read this user's application timeline for one listing. */
export async function loadApplication(id) {
  return (await xhrGet(listingPath('/api/applications', id))).json;
}

/** Save a reviewed draft or a manually recorded lifecycle transition. */
export async function saveApplication(id, draft) {
  return (await xhrPost(listingPath('/api/applications', id), draft)).json;
}

/** Append a note or manually recorded reply; the server records its source. */
export async function addApplicationEvent(id, event) {
  return (await xhrPost(`${listingPath('/api/applications', id)}/events`, event)).json;
}

/** Read all applications visible to the current user. */
export async function loadApplications() {
  return (await xhrGet('/api/applications')).json;
}

/** Calendar downloads remain authenticated and scoped to this listing's current user. */
export function visitCalendarUrl(id) {
  return `${listingPath('/api/applications', id)}/visit.ics`;
}
