# Listing fit filter and sorting

Scope: standard, reversible UI/query behavior. Preserve all pre-existing dirty edits. No branch, commit, push, deployment, or inference.

Acceptance:
- A1: Listings drawer offers optional minimum listing fit on the existing 0–10 display scale. Applied globally before pagination, with matching totals and bulk-filter behavior. Clear/reset/chips/URL preserve existing conventions.
- A2: Listing-fit sorting on listings uses the existing user-scoped saved-score sort, best first on selection, reversible, unassessed last.
- A3: Map offers minimum fit and sort by fit (high/low first), with URL persistence. Same filtered set drives pins/stacks and results; sort applies after viewport grouping to avoid breaking score order at shared addresses. Default map ordering unchanged.
- A4: Unassessed stays visible without a floor, excluded with any floor including zero. Saved zero is real; current-user receipts only, stale/failure warnings unchanged. No model requests.

Decision: use stored percentage for comparison/sorting, matching existing fit sort; controls display 0–10. Minimum UI options 0–10 in one-point steps; URL supports fractional thresholds. Invalid/out-of-range values normalize to no filter. Reuse shared listing WHERE for count/page/delete with a user-scoped EXISTS, no migration. Rename existing JEV sort label to Listing fit, retaining translation key and URL compatibility.

Plan:
1. Baseline focused UI/storage/API suites; add behavior tests for floor, user scoping, totals/pages/deletion, invalid inputs and map ordering.
2. Extend API normalization + shared storage WHERE; wire listings URL/query/drawer/chips and localizations.
3. Wire map URL/floor/count and viewport sorting; test grouped results and null/zero/ties.
4. Run linter, offline suite and frontend build; browser exercise both real pages using isolated local fixture runtime if needed. Fresh read-only review of scoped diff, fix substantiated findings.

Plan challenge: global filter must precede LIMIT; count/delete must use same WHERE; floors must not use listing owner's score; null is not zero; viewport grouping can disturb sorting, so sort viewport output. No substantial architecture changes.

Progress: inspected existing fit sort/storage and map/sidebar code. Relevant prior work is local/uncommitted; preserved by checking initial status. Baseline and implementation pending.

Checks/review:
- Independent plan challenge PASS; addressed existing fit-group gate and empty-string codec, and sorted after viewport grouping.
- Baseline: 110 focused tests PASS. Red tests: 20 expected failures for missing behavior. Initial green pass exposed an overly strict assertion on the existing created_at sort's equal-date ties; corrected it to verify newer first and full membership, without changing production sorting.
- Full offline suite PASS: 404 files passed, 1 skipped; 5,300 tests passed, 33 skipped. Includes real-SQLite floor/count/pagination/shared-user/admin/delete checks, route normalization and map/URL helper tests.
- `oxlint .` PASS. Focused `oxfmt --check` on all 14 changed JS/JSX files PASS. `git diff --check` PASS.
- `vite build` PASS (existing third-party module directive and locale import warnings).
- Independent final scoped source review PASS: no substantiated blocking findings. Runtime browser acceptance pending.

Final acceptance:
- A1 PASS: browser exercised real listings page/drawer with fixture API data, no finance/address profile; floor selection emits minFitScore=70, chip displays floor, reload retains it, Clear all removes floor while preserving fit sort. Real SQLite tests prove global filtering, count, pagination and matching bulk deletion.
- A2 PASS: existing sort now labelled Listing fit; browser selects it and observes fit_score/desc request. Existing direction/URL and real-SQLite sort tests pass.
- A3 PASS: real MapLibre/browser tested floor selection shared by pins/results, ascending and descending result order, same-address rows, reload persistence, 390px phone controls and no horizontal overflow. Phone clear restores all assessed and unassessed results.
- A4 PASS: cold bookmarks for minFit=0 retain assessed zero and exclude unassessed; empty minimum leaves filtering off. Real SQLite checks enforce current-user scope including shared/admin listings. No model endpoints requested by the browser.
- Browser first hit the existing Semi Select limitation: aria-label is ignored. Fixed new controls to supported aria-labelledby with visible labels; independent narrow re-review PASS. Subsequent affected regression: 80 files/1,342 tests PASS; lint and rebuilt frontend PASS. Early browser zero-floor expectation used hash navigation retaining the previous narrow camera viewport; changed the bookmark test to a cold reload, matching the actual viewport-only results contract. No product viewport change made.
- Final browser run PASS, no page errors: `/tmp/fredy-minfit-browser.mjs` and `/tmp/fredy-minfit-browser.log`. Browser used controlled API fixtures and actual built frontend/MapLibre, not production data. Screenshots: `/tmp/fredy-minfit-map-desktop.png`, `/tmp/fredy-minfit-map-phone.png`, `/tmp/fredy-minfit-listings-desktop.png`; visually inspected.
- Independent final review and post-accessibility narrow review PASS, no unresolved findings. Final diff/format checks PASS.
- Implementation complete in existing main working tree. No branch, commit, push, PR or deployment. Pre-existing dirty files preserved. Temporary preview server stopped after acceptance.


## Publication and live deployment (authorized 2026-11-01)
User requested commit/push to main, Mac Mini deployment and live UI acceptance. Stage only task changes; shared locale files use task-only blobs. Existing worker performs checked, backed-up, revision-labelled deployment. Live verification pending; no model calls or production fixture data.
- Exact staged-index snapshot (without unrelated application/email edits): lint, complete JS/JSX format check, all offline tests (5,311 passed / 33 skipped; 404 files passed / one skipped), and all 23 deployment tests PASS.
