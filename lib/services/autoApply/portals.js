/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Browser application contracts. Unknown portal routes always require human intervention. */
export const PORTALS = Object.freeze({
  immoscout: {
    name: 'ImmoScout24',
    home: 'https://www.immobilienscout24.de/',
    hosts: ['www.immobilienscout24.de', 'immobilienscout24.de'],
    advert: /^\/expose\/(\d+)(?:\/|$)/i,
    submission: /^\/(?:restapi\/api\/)?(?:expose\/\d+\/contact(?:request)?|contact\/request|contactrequest)(?:\/|$)/i,
    upload: /^\/(?:restapi\/api\/)?(?:contact|application)\/attachments(?:\/|$)/i,
  },
  immowelt: {
    name: 'Immowelt',
    home: 'https://www.immowelt.de/',
    hosts: ['www.immowelt.de', 'immowelt.de'],
    advert: /^\/expose\/([a-z0-9-]+)(?:\/|$)/i,
    submission: /^\/(?:api\/)?(?:contactrequests|contact-request|inquiry)(?:\/|$)/i,
    upload: /^\/(?:api\/)?(?:contact|application)\/attachments(?:\/|$)/i,
  },
  kleinanzeigen: {
    name: 'Kleinanzeigen',
    home: 'https://www.kleinanzeigen.de/',
    hosts: ['www.kleinanzeigen.de', 'kleinanzeigen.de'],
    advert: /^\/s-anzeige\/[^/]+\/(\d+)(?:-|\/|$)/i,
    submission: /^\/(?:s-anfrage\.html|m-ajax-bff\/conversations\/send)(?:\/|$)/i,
    upload: /^\/m-ajax-bff\/conversations\/attachments(?:\/|$)/i,
  },
});

/** Parse only HTTPS portal destinations, rejecting credentials, nonstandard ports and lookalikes. */
export function portalUrl(portal, value) {
  try {
    const url = new URL(value);
    return PORTALS[portal]?.hosts.includes(url.hostname) &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
      ? url
      : null;
  } catch {
    return null;
  }
}

/** A user-independent advert key shared by ingestion and browser evidence. */
export function canonicalAdvert(portal, value) {
  const url = portalUrl(portal, value);
  const id = url?.pathname.match(PORTALS[portal]?.advert)?.[1];
  return id ? `${portal}:${id.toLowerCase()}` : null;
}

/** Classify only supported writes. A similarly named foreign host or unknown route is never accepted. */
export function classifyPortalRequest(portal, url, method) {
  const parsed = portalUrl(portal, url);
  if (!parsed) return 'external';
  if (PORTALS[portal].submission.test(parsed.pathname)) return method === 'POST' ? 'submission' : 'unknown';
  if (PORTALS[portal].upload.test(parsed.pathname)) return method === 'POST' ? 'upload' : 'unknown';
  if (/\/(?:send|submit|apply|message|anfrage)(?:[/.]|$)/i.test(parsed.pathname)) return 'unknown';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  if (method !== 'POST') return 'unknown';
  return 'unknown';
}

/** Decode a supported JSON or URL-encoded form without flattening away duplicate fields. */
export function applicationPayload(body) {
  if (typeof body !== 'string' || body.length > 1000000) return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    const entries = [...new URLSearchParams(body)];
    if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) return null;
    return Object.fromEntries(entries);
  }
}

/**
 * Require exact named advert/message fields and exact frozen answers. Extra payload fields are
 * refused except portal anti-CSRF tokens; unknown wire formats need an explicit adapter update.
 */
export function submissionMatches(portal, request, intent) {
  if (classifyPortalRequest(portal, request.url, request.method) !== 'submission') return false;
  const payload = applicationPayload(request.body);
  const id = intent.advertKey?.slice(portal.length + 1);
  if (!payload || !id || !intent.message?.trim()) return false;
  const idKeys = {
    immoscout: ['exposeId', 'realEstateId'],
    immowelt: ['estateId', 'exposeId'],
    kleinanzeigen: ['adId'],
  }[portal];
  const idFields = idKeys.filter((key) => Object.hasOwn(payload, key));
  const messageFields = ['message', 'messageText', 'contactMessage'].filter((key) => Object.hasOwn(payload, key));
  if (
    idFields.length !== 1 ||
    String(payload[idFields[0]]) !== id ||
    messageFields.length !== 1 ||
    payload[messageFields[0]] !== intent.message
  )
    return false;
  const attachmentIds = (intent.uploadReceipts ?? []).map((receipt) => receipt.attachmentId).sort();
  const sentAttachmentIds = payload.attachmentIds ?? [];
  if (
    !Array.isArray(sentAttachmentIds) ||
    JSON.stringify([...sentAttachmentIds].sort()) !== JSON.stringify(attachmentIds)
  )
    return false;
  const answers = intent.answers ?? {};
  const seen = new Set();
  for (const [key, value] of Object.entries(payload)) {
    if (
      [...idFields, ...messageFields, 'attachmentIds'].includes(key) ||
      /^(?:csrf|csrfToken|_csrf|authenticity_token)$/.test(key)
    )
      continue;
    const fields =
      key === 'sender' && value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value)
        : [[key, value]];
    for (const [field, answer] of fields) {
      if (typeof answer === 'object' || !Object.hasOwn(answers, field) || String(answer) !== String(answers[field]))
        return false;
      seen.add(field);
    }
  }
  return Object.entries(answers).every(([key, value]) => value === intent.message || seen.has(key));
}

/** Only affirmative, complete success messages count; error/negation prose cannot match. */
export function isPositiveConfirmation(text) {
  return (
    (typeof text === 'string' &&
      /^(?:(?:Ihre|Deine|Die)\s+)?(?:Nachricht|Anfrage|Bewerbung)\s+(?:(?:wurde|ist)\s+)?(?:erfolgreich\s+)?(?:gesendet|versendet|übermittelt)(?:\s+worden)?[.!]?$/i.test(
        text.trim(),
      )) ||
    (typeof text === 'string' &&
      /^(?:(?:Your|The)\s+)?(?:message|enquiry|application)\s+(?:(?:was|has been)\s+)?(?:successfully\s+)?(?:sent|submitted)[.!]?$/i.test(
        text.trim(),
      ))
  );
}

/** Deterministic receipt validation, independent of the model's success claims. */
export function verifyConfirmation(portal, evidence) {
  const receipt = evidence?.request;
  return Boolean(
    evidence &&
    evidence.accountIdentity &&
    evidence.advertKey?.startsWith(`${portal}:`) &&
    portalUrl(portal, evidence.url) &&
    receipt?.authorized === true &&
    receipt.status >= 200 &&
    receipt.status < 300 &&
    classifyPortalRequest(portal, receipt.url, receipt.method) === 'submission' &&
    evidence.confirmationSelector &&
    isPositiveConfirmation(evidence.confirmationText),
  );
}
