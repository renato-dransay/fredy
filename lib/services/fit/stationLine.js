/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { distanceMeters } from '../listings/distanceCalculator.js';
import { fetchStreetRoute } from '../transit/transitousClient.js';

const cache = new Map();
let serial = Promise.resolve();
let lastLookup = 0;
const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Exposed for isolated tests; station positions/results are cached for a day, outages for a minute. */
export function clearStationLineCache() {
  cache.clear();
  lastLookup = 0;
}

/** Enforce one Overpass request at a time, with spacing, even for concurrent fit requests. */
async function throttledLookup(task) {
  const run = serial.then(async () => {
    const delay = Math.max(0, lastLookup + 1000 - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastLookup = Date.now();
    return task();
  });
  serial = run.catch(() => {});
  return run;
}

/** A shared routing queue may be busy; stop waiting at this evaluation's deadline as well. */
async function beforeDeadline(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('Evaluation deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Read and validate a bounded Overpass response. Fixed endpoint and validated literals prevent query injection. */
async function stationsForLine(lat, lng, line, radius, request, signal) {
  const anySubway = line === '*';
  // An explicit any-U-Bahn rule never broadens to light rail or suburban trains. Return the
  // relations as evidence too, so an unrelated station cannot be accepted just because it is near.
  const query = anySubway
    ? `[out:json][timeout:10];rel(around:${radius},${lat},${lng})[type=route][route="subway"];out body 120;node(r)(around:${radius},${lat},${lng});out body 120;`
    : `[out:json][timeout:10];rel(around:${radius},${lat},${lng})[type=route][route~"^(subway|light_rail)$"][ref="${line}"];node(r);out body 120;`;
  const response = await request(ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(15000), signal]),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Fredy-self-hosted/fit-station-lookup',
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok || !response.body) throw new Error('Station lookup unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error('Station response limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(data.elements) || data.remark) throw new Error('Incomplete station response');
  const relations = data.elements.filter((element) => element.type === 'relation');
  const subwayMembers = new Set();
  if (anySubway) {
    for (const relation of relations.slice(0, 120)) {
      if (relation.tags?.type !== 'route' || relation.tags?.route !== 'subway') continue;
      for (const member of relation.members ?? []) {
        if (member.type === 'node') subwayMembers.add(member.ref);
      }
    }
  }
  const nodes = data.elements.filter((element) => element.type === 'node');
  const unique = new Map();
  for (const node of nodes.slice(0, 120)) {
    if (
      node.type !== 'node' ||
      (anySubway && !subwayMembers.has(node.id)) ||
      !Number.isFinite(node.lat) ||
      !Number.isFinite(node.lon) ||
      Math.abs(node.lat) > 90 ||
      Math.abs(node.lon) > 180 ||
      (!['station', 'halt', 'stop'].includes(node.tags?.railway) && node.tags?.public_transport !== 'stop_position')
    )
      continue;
    const distance = distanceMeters(lat, lng, node.lat, node.lon);
    if (distance > radius) continue;
    const name = String(node.tags?.name ?? `OSM stop ${node.id}`).slice(0, 160);
    const key = `${name}:${node.lat.toFixed(3)},${node.lon.toFixed(3)}`;
    if (!unique.has(key)) unique.set(key, { name, lat: node.lat, lng: node.lon, distance, osmId: node.id });
  }
  return {
    stations: [...unique.values()].sort((a, b) => a.distance - b.distance),
    complete: nodes.length < 120 && (!anySubway || relations.length < 120),
  };
}

/**
 * Assess a named rail line, or `*` for any U-Bahn line, using nodes in matching OSM route relations, then
 * real walking routes. Generic nearby stops and straight-line estimates never produce a match.
 * At most three candidate routings are made; incomplete coverage means unknown, not rejection.
 */
export async function evaluateStationLine(
  criterion,
  listing,
  { request = fetch, route = fetchStreetRoute, signal = AbortSignal.timeout(60000) } = {},
) {
  const unknown = (text) => ({
    verdict: 'unknown',
    confidence: 0,
    evidence: text ? [{ source: 'station_lookup', text }] : [],
  });
  const lat = listing.latitude;
  const lng = listing.longitude;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === -1 && lng === -1)
  ) {
    return unknown('No usable listing coordinates are available.');
  }
  if (
    (criterion.line !== '*' && !/^[A-Z0-9][A-Z0-9 -]{0,15}$/.test(criterion.line)) ||
    !Number.isInteger(criterion.maxWalkMinutes) ||
    criterion.maxWalkMinutes < 1 ||
    criterion.maxWalkMinutes > 60
  ) {
    return unknown('Invalid rail-line requirement.');
  }
  // 3 m/s is a generous walking upper bound. This radius is not used as an actual walking time.
  const radius = Math.min(10000, Math.max(300, criterion.maxWalkMinutes * 180));
  const key = `${lat},${lng}:${criterion.line}:${criterion.maxWalkMinutes}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      signal.throwIfAborted();
      const found = await beforeDeadline(
        throttledLookup(() => stationsForLine(lat, lng, criterion.line, radius, request, signal)),
        signal,
      );
      if (!found.stations.length)
        return unknown(
          `No verified ${criterion.line === '*' ? 'U-Bahn' : criterion.line} station was returned in the bounded search. This is not proof that none exists.`,
        );
      const candidates = found.stations.slice(0, 3);
      let incomplete =
        !found.complete || found.stations.length > candidates.length || criterion.maxWalkMinutes * 180 > radius;
      const evidence = [];
      for (const station of candidates) {
        signal.throwIfAborted();
        const answer = await beforeDeadline(
          route({
            mode: 'WALK',
            fromLat: lat,
            fromLng: lng,
            toLat: station.lat,
            toLng: station.lng,
          }),
          signal,
        );
        if (!answer?.answered || !Number.isFinite(answer.route?.minutes) || answer.route.minutes < 0) {
          incomplete = true;
          continue;
        }
        const text = `${criterion.line === '*' ? 'U-Bahn (any line)' : criterion.line}: ${station.name}, ${answer.route.minutes} minutes walking (limit ${criterion.maxWalkMinutes}); OSM node ${station.osmId}.`;
        evidence.push({ source: `station:${station.osmId}`, text });
        if (answer.route.minutes <= criterion.maxWalkMinutes)
          return { verdict: 'met', confidence: 1, evidence: [evidence[evidence.length - 1]] };
      }
      return { verdict: incomplete ? 'unknown' : 'unmet', confidence: incomplete ? 0 : 1, evidence };
    } catch {
      return unknown('Station or walking-route service unavailable.');
    }
  })();
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  const entry = { promise, expires: Date.now() + 60000 };
  cache.set(key, entry);
  promise.then((result) => {
    entry.expires = Date.now() + (result.verdict === 'unknown' ? 60000 : 86400000);
  });
  return promise;
}
