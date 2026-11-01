/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Change the sort in one URL update. JEV score starts with the best scores on page one, even
 * when the previous sort was ascending; other sorts keep the user's chosen direction.
 * @param {string} field The selected listing sort field.
 * @returns {{sort: string, page: number, dir?: string}} Patch for useUrlState.setValues.
 */
export function listingSortPatch(field) {
  return { sort: field, page: 1, ...(field === 'fit_score' ? { dir: 'desc' } : {}) };
}
