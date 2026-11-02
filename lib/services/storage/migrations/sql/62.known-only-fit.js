/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Recalculate scores from saved verdicts without changing evidence, freshness or buying inference. */
export function up(db) {
  db.exec(`UPDATE apartment_fit_results SET result = json_set(result, '$.score', (
    SELECT CAST(ROUND(100.0 * SUM(
      CASE WHEN json_extract(c.value, '$.verdict') = 'met'
        THEN json_extract(c.value, '$.weight') ELSE 0 END
    ) / NULLIF(SUM(
      CASE WHEN json_extract(c.value, '$.verdict') IN ('met', 'unmet')
        THEN json_extract(c.value, '$.weight') ELSE 0 END
    ), 0)) AS INTEGER)
    FROM json_each(apartment_fit_results.result, '$.criteria') AS c
  ))`);
}
