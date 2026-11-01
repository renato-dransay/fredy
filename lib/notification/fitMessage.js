/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const LABELS = {
  en: {
    failed: 'Does not meet requirements',
    unknown: 'Needs clarification',
    matched: 'Meets requirements',
    unavailable: 'Assessment unavailable',
    pending: 'Assessment pending',
  },
  de: {
    failed: 'Erfüllt Anforderungen nicht',
    unknown: 'Klärung nötig',
    matched: 'Erfüllt Anforderungen',
    unavailable: 'Bewertung nicht verfügbar',
    pending: 'Bewertung ausstehend',
  },
  tr: {
    failed: 'Gereksinimleri karşılamıyor',
    unknown: 'Açıklama gerekli',
    matched: 'Gereksinimleri karşılıyor',
    unavailable: 'Değerlendirme kullanılamıyor',
    pending: 'Değerlendirme bekleniyor',
  },
};

/**
 * Decorate only a private destination's headline with a generic status. The input and returned
 * payload contain no assessment document, criteria, reason, score or evidence.
 * @param {object} listing
 * @param {string|null} status Null preserves ordinary discovery notifications.
 * @param {string} language
 * @returns {object}
 */
export function withFitNotificationStatus(listing, status, language = 'en') {
  const label = (LABELS[language] ?? LABELS.en)[status];
  return label ? { ...listing, title: `[${label}] ${listing.title ?? ''}` } : listing;
}
