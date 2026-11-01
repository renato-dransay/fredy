# Listing and map UI simplification

Scope: local code only; preserve pre-existing dirty application/email and locale changes. No branch, commit, push or deployment.

## Contract
- U1: Listings overview/detail present photo, price, address and essentials before secondary workspaces; retain actions and status management.
- U2: JEV criterion chips show short keywords and topic icons, full criteria accessible by keyboard/touch disclosure. Repeated summaries compact but preserve stale/required warnings accessibly.
- U3: Map filters initially folded at every width, layers separated, legend discoverable, viewport/list/pin synchronization and fullscreen preserved.
- U4: Search profile UI edits actual JEV instructions plus optional criterion labels/icons; instructions private, bounded, persisted, used in manual/automatic evaluations, included in freshness/concurrency snapshot. No inference from reads.

## Plan / design challenge
Existing criteria/document editor alone does not fulfill U4. Add an additive text column with empty fallback to default instructions; no live migration. Existing profile version/hash protects in-flight changes. Preserve immutable evidence guards. Keyword labels need conservative topic matching plus user override; arbitrary requirements get neutral fallback rather than guessed claims. Native disclosure supplies touch/keyboard full text. Compact summaries keep named warnings without repeated prose.

Independent read-only plan review by ui_review: P1 instruction wiring/hash required; P2 full text accessible beyond title; P3 legend cannot be trapped in folded filters; P4 warnings cannot become color only; P5 no inference on mount. All accepted into plan.

## Work
- Baseline focused fit/map/UI tests and lint started.
- Delegated bounded chip presentation + disclosure implementation to ui_review; coordinator owns all remaining integration.

## Integrated implementation
- U1: Photos and key facts lead detail view at all widths; application tracking/notes/transit/connectivity fold with native disclosure. Grid address separated from rooms/area. Repeated affordability/market badges kept on detailed finance/facts surfaces, removed from repeated overview rows.
- U2: Topic/threshold keyword chips and 11 topic icons, optional overrides, native per-chip full-text disclosure. Compact saved summary disclosure in grid/table/map cards retains warning symbol and all accessible labels.
- U3: Filters initially folded at all widths, map layers inside own disclosure, legend always separately reachable. Added Show all matches to recover from panning away without clearing filters.
- U4: Additive migration57 instructions column, bounded4000-char private instructions persisted/versioned with profile. Optional32-char label/icon whitelist. UI save wires guidance to semantic state once, fixed evidence guards per question; hash binds instructions and concurrent writes reject obsolete results.
- Baseline:139 focused tests passed, lint passed. New focused chunk149 passed. Migration test first failed on missing FK fixture parents, next attempt had a quote syntax mistake; fixture corrected, isolated migration test passed. These were new test fixture errors, not ignored product failures.
- Browser preliminary: real frontend + fixture APIs, actual MapLibre tiles/canvas; map zoom/pan/stack selection/keyboard/fullscreen/medium/phone/price-filter checks passed. Chip dark/light desktop/phone no overflow. Final integrated acceptance and full tests pending.

## Assessment findings
- Repeated financial/coverage/warning badges obscured price and location; sentence chips were clipped rather than summarized. Overview now prioritizes essentials and uses compact expandable fit summaries.
- Detail pages put assessment/application editors before photography and expanded every workspace. Photos and price now lead, secondary workspaces fold.
- The map's mixed-purpose controls competed with the results, hid its legend, and provided no viewport recovery. Filters/layers/legend have distinct access points and Show all matches restores filtered pins.
- The existing preferences editor did not expose actual JEV instructions. New private instructions, optional short labels and topic icons close that gap.

## Final review and repair ledger
- R1/P2 (independent): invalid coordinates inflated recovery counts and could crash bounds. Accepted; shared filtering now requires hasMapPosition. Mixed/all-invalid browser fixtures pass.
- R2/P2 (browser): same-mounted URL price changes updated badges but left pins stale. Accepted; URL/data changes synchronize both ranges and cancel pending slider commits. Browser schedules slider input, navigates before debounce, and confirms the URL and three matching results survive.
- Four obsolete source-string assertions replaced (old two-group layout, heading, width-dependent fold, price initializer). Panel interaction tests and the production-browser harness verify the current behavior.
- Independent final source review: PASS, no unresolved findings; includes instruction privacy, legacy hash compatibility and debounce repair.

## Final acceptance (uncommitted working tree on HEAD 7588dbb)
- U1 PASS: production frontend with fixture APIs at desktop1440/phone390; essentials/photo-first detail order, folded workspaces, preserved actions, no horizontal overflow.
- U2 PASS: keyword summaries and6 topic icons in representative assessment; click/Enter full-text disclosures; compact score expands without navigating. Dark/light detail checks at both widths pass.
- U3 PASS: actual MapLibre canvas/tiles with fixture APIs. Zoom/pan/stack selection/keyboard/fullscreen/medium/phone/price filtering pass. Final folded filters, independent legend, layers disclosure, recovery, URL retention, mixed/all-invalid positions and pending-input navigation pass. No page errors.
- U4 PASS: real UI edits/saves/reloads instructions and chip overrides. Real SQLite/Fastify tests prove private persistence, validation, freshness/in-flight rejection and evaluator payload wiring. Zero inference calls on page reads/edits. No live paid inference attempted.
- Full offline suite:406 files passed,1 skipped;5,325 tests passed,33 skipped. `/tmp/fredy-ui-full-complete.log`.
- Lint and full formatting: PASS (998 JS/JSX files); browser .mjs explicitly formatted. Diff whitespace check PASS.
- Production build PASS; existing bundler directive/Semi locale dynamic/static warnings remain nonblocking. `/tmp/fredy-ui-build-verified.log`.
- Final browser PASS: `/tmp/fredy-ui-browser-complete.log`. Reproducible `verify-browser.mjs`: build frontend, start vite preview on port4178, run script with node. Screenshots in `screenshots/`.
- Failed attempts retained: migration fixture parent/quote errors corrected; superseded assertions replaced; browser controlled-text harness fixed with native select/type; all-invalid fixture harness reloads to actually deliver new data. Product URL-price mismatch was repaired.
- Prior unrelated application/email/source/locale edits preserved. No branch, commit, push, PR, live migration or deployment. Additive migration57 preserves profile/result data; default guidance preserves old receipts.


## Publication and Mac Mini deployment (authorized 2026-11-01)
- User explicitly authorized push to main, Mac Mini deployment and live verification. This supersedes the earlier local-only delivery boundary.
- Staged only the UI/JEV task:42 files. Locale staging adds only new task keys; documentation preserves the original Applications section. Unrelated application/email removal remains unstaged.
- Independent staged-release boundary review PASS; original HEAD ApplicationTracker and APIs remain compatible.
- Exact staged source exported and checked in ARM64 fredy-development:base: lint, full formatting, full offline suite, frontend build and23 deployment/recovery tests PASS. `/tmp/fredy-ui-release-check.log`.
- Live baseline: revision7588dbb,211 active/assessed listings, one job/user; private profile version2 and content hash captured without storing credentials.
- Remaining: commit/push, await worker activation with verified backup/integrity, real live UI/API acceptance (including disposable-account config save/reload), then idle worker poll.
