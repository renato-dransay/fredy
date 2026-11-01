# JEV assessment visibility

User request: run the saved live profile against existing listings; results should be visible in list and detail. Continue prior main push/deploy delivery authorization within this feature. Preserve concurrent unrelated email-removal edits in the primary checkout. Work in this isolated detached checkout, base f7f5570997c66f2c683bfd529271686feaa087ed.
Risk: standard, with user-private results and explicitly requested provider inference.

A1 Run a bounded snapshot of current active, visible listings through the existing authenticated assessment endpoint; reuse fresh receipts; no future automatic calls. Verify each successful receipt through GET/persisted storage. Stop new calls on provider outage and report partial/failures honestly.
A2 List/table and grid display current user's saved fit score, coverage, failed/unknown must-haves, stale state, and not-assessed state. Never imply a high score overrides a failed/unknown required criterion. No model calls during reads/rendering.
A3 Detail shows its assessment near the listing title (including narrow screens), with expandable per-criterion verdict/source evidence, existing Evaluate control and edit-profile link. Keep cached result on failure.
A4 Summary reads remain user-scoped even for admin/shared listings and reflect current profile/evidence staleness. Batch query once per page; do not copy full private criteria/document into list payload.
A5 Meaningful backend/render tests, all offline tests/lint/format/build, independent design/final review, actual API acceptance. Browser check subject to current tool availability; do not claim passed if disabled.

Plan: add fit summary projection helper in fit/storage.js and attach only to already authorized table/detail rows in listingsRouter (one bounded stored-results query plus one profile read). UI shared FitSummary in table/grid and FitCard; move FitCard to main column below title and collapse detailed criteria. Six locale copy/docs. Test projection/staleness/user isolation, real API row exposure, rendering/wiring/no-result and warning states. No schema changes, no scheduled background assessments or altered profile/scoring rules.

Initial evidence: live profile version1 has17 criteria/provider configured. First real API evaluation succeeded, saved score28/coverage40, both hardFailure/hardUnknown. Existing detail FitCard is first in rail, absent from list. Primary checkout has unrelated email-removal work; isolated worktree avoids it. Local browser access was disabled earlier; recheck for this task only if relevant UI tool state changes.

Implementation/check evidence:
- Live assessment run complete:195/195 current active visible listings,0failed calls; each persisted receipt reread throughGET and checked equal/fresh/profileVersion1. Existing endpoint reused the earlier fresh receipt. Report outsideGit at .config/fredy-live/fit-assessment-run-20261101.json; no credentials or preference document in artifacts.
- Snapshot aggregate:136failedatleastone must-have;194with unknownmusthaves;0allmusthavesconfirmed;highestscore71. These are overlapping warning flags, not recommendation counts.
- Added2boundedqueries/page for current-user summaries; no schema/model/profile/scoring changes. FitSummary in actualtable/grid +prominentdetailcard beforephotos with expandablecriteria and evidence.
- Newbackendtests reproduced6failures before implementation, then6PASS. NewactualReactSSR renderingtests6PASS cover table/grid/detail,zero vsunassessed,loading,coverage/stale/requiredflags/disclosure. Independent finalreview PASS with12newtests independentlyrun.
- First full run exposed4old affordabilityfixture failures because mockedroute acquired new DB dependency; fixture now isolates fitprojection, assertionsunchanged. NewfitAPItests use realSQLite and sameprojection. Finalfullsuite5178PASS/33skipped,lint/format/buildPASS,11deploymentrecoverytestsPASS. Build retains existingvendor eval/importwarnings.
- Browser check NOT RUN: CUA againexplicitly returned "Local browser use is disabled in Work settings". ActualSSRcomponents and API tests validate output/contracts; visualappearance remains unverified, disclose it. No alternatebrowserautomation attempted.
- Publication/deployment permitted by prior explicitPush/Deploy authorization for this continuingfeature; unrelatedprimarycheckoutchanges preserved. Existingworker immutablechecks/verifiedvolumebackups/revision/auth/schema acceptance remain required.
