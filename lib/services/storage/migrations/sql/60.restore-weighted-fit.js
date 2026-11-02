/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Restore ranking information from saved verdicts; preserve evidence, eligibility and assessment dates. */
export function up(db) {
  db.exec(`UPDATE apartment_fit_results SET result = json_set(result, '$.score', (
    SELECT COALESCE(CAST(ROUND(100.0 * SUM(
      CASE WHEN json_extract(c.value, '$.verdict') = 'met'
        THEN json_extract(c.value, '$.weight') ELSE 0 END
    ) / NULLIF(SUM(json_extract(c.value, '$.weight')), 0)) AS INTEGER), 0)
    FROM json_each(apartment_fit_results.result, '$.criteria') AS c
  ))`);
}
