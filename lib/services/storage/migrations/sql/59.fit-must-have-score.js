/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Rescore confirmed failures for existing filters/sorts without changing evidence or buying inference. */
export function up(db) {
  db.exec(`UPDATE apartment_fit_results
    SET result = json_set(result, '$.score', 0, '$.hardFailure', json('true'))
    WHERE EXISTS (
      SELECT 1 FROM json_each(apartment_fit_results.result, '$.criteria') AS criterion
      WHERE json_extract(criterion.value, '$.required') = 1
        AND json_extract(criterion.value, '$.verdict') = 'unmet'
    )`);
}
