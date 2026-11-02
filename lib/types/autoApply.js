/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * @typedef {'immoscout'|'immowelt'|'kleinanzeigen'} ApplicationPortal
 * @typedef {'pending_assessment'|'queued'|'running'|'needs_input'|'submitting'|'submitted'|'uncertain'|'failed'|'cancelled'|'skipped'} AutoApplyState
 * @typedef {Object} AutoApplyRule
 * @property {string} jobId Owned search; shared access does not permit authoring a rule.
 * @property {boolean} enabled Explicit authorization for model use and automatic portal submission.
 * @property {number} minimumScore Inclusive known-only score on the displayed 0–10 scale.
 * @property {ApplicationPortal[]} portals
 * @property {string[]} documentIds Private selected applicant files, never listing attachments.
 * @property {Partial<Record<ApplicationPortal,string>>} connectionIds Portal-specific paired browsers.
 * @property {string} generation Activation identity; re-enabling cannot replay old candidates.
 * @property {number} since Activation epoch milliseconds.
 * @property {number} revision Changes revoke prepared submission authorizations.
 */

/**
 * @typedef {Object} AutoApplyRun
 * @property {string} id
 * @property {string|null} listingId Null after source deletion; submission history remains.
 * @property {string|null} jobId
 * @property {ApplicationPortal} portal
 * @property {'manual'|'search'} origin
 * @property {AutoApplyState} state Separate from the user's application lifecycle status.
 * @property {string|null} reason Safe category, never an upstream error or credential.
 * @property {string|null} connectionId
 * @property {Object|null} snapshot Private exact content, facts, documents and eligibility receipt.
 * @property {Object|null} receipt Verified portal evidence or explicit manual reconciliation.
 * @property {Object|null} usage Measured provider token/cost totals; unavailable prices are not estimates.
 * @property {number} createdAt Epoch milliseconds.
 * @property {number} updatedAt Epoch milliseconds.
 */

/**
 * @typedef {Object} ApplicantDocument
 * @property {string} id
 * @property {string} filename Sanitized display name; never a filesystem path.
 * @property {string} description Private owner-authored explanation, never appended to a portal message.
 * @property {'application/pdf'|'image/jpeg'|'image/png'} mimeType Magic-byte verified type.
 * @property {number} size Byte count.
 * @property {string} hash SHA-256 over uploaded bytes, bound into the application receipt.
 * @property {number} createdAt Epoch milliseconds.
 */

export {};
