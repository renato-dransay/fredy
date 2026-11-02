/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { evaluateSemantic } from '../../lib/services/fit/jev.js';
import { sourcesForListing } from '../../lib/services/fit/evaluate.js';

/** Synthetic, labelled furnishing cases. This opt-in eval makes seven paid Jev requests. */
const cases = [
  [
    'fully-furnished-de',
    'Voll möblierte Wohnung',
    'Die Wohnung wird vollständig eingerichtet und ausgestattet vermietet.',
    'unmet',
  ],
  [
    'fully-furnished-en',
    'Furnished apartment',
    'The apartment is let fully furnished, including beds, sofa and wardrobes.',
    'unmet',
  ],
  ['partly-furnished', 'Teilmoeblierte Wohnung', 'Die Wohnung wird teilmöbliert mit Bett und Sofa vermietet.', 'unmet'],
  [
    'unfurnished-with-kitchen',
    'Unmöblierte Wohnung mit Einbauküche',
    'Die Wohnung wird unmöbliert vermietet. Die Einbauküche bleibt enthalten.',
    'met',
  ],
  ['kitchen-only-evidence', 'Wohnung mit Einbauküche', 'Einbauküche mit Herd und Spülmaschine vorhanden.', 'unknown'],
  ['no-furnishing-evidence', 'Helle Wohnung', 'Drei Zimmer, Balkon und Badewanne.', 'unknown'],
  [
    'conflicting-evidence',
    'Unmöblierte Wohnung',
    'Die Wohnung wird ausschließlich vollständig möbliert vermietet.',
    'unknown',
  ],
];

const criterion = {
  id: 'unfurnished',
  text: 'The apartment must be unfurnished. Fully or partly furnished accommodation does not meet this requirement. A fitted kitchen is compatible with unfurnished accommodation and is still required separately. Missing or conflicting furnishing information is unknown.',
  kind: 'semantic',
  required: true,
  weight: 10,
};

/** Run independently labelled evidence through the production Jev adapter. */
async function run() {
  const results = [];
  for (const [id, title, description, expected] of cases) {
    const answer = await evaluateSemantic([criterion], sourcesForListing({ title, description }));
    const actual = answer.results[0];
    results.push({
      id,
      expected,
      actual: actual.verdict,
      passed: actual.verdict === expected,
      confidence: actual.confidence,
      evidence: actual.evidence,
      model: answer.model,
    });
  }
  const report = {
    evaluatedAt: new Date().toISOString(),
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}

await run();
