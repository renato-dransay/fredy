# OpenRouter config UI

Scope: user authorized "Push! Deploy!" on 2026-11-01 after initial implementation. Publish only OpenRouter changes to main, deploy through the existing guarded Mac Mini worker, verify served revision. No paid provider calls.
Risk: standard, with credential exposure and authorization checks. Existing settings storage and admin authorization remain the boundary.

## Contract
A1 Admin can set/replace/remove the personal OpenRouter key in Administration → System, using a password input and configured/source status.
A2 Key persists in global SQLite settings, applies immediately to Jev status and requests, and survives restart. UI-saved key overrides personal environment key; removal restores environment fallback. Never use shared OPENROUTER_API_KEY.
A3 Never return the saved key through settings/profile responses. Blank/omitted key retains current value; explicit null removes it. Reject malformed types, oversized values, and embedded whitespace/control characters without echoing input. Non-admin writes denied.
A4 Existing System saves/discard work, clear password after successful save, six locale strings and setup docs updated. Required lint/offline tests/build and isolated browser save/reload checked; no real secrets used in verification.

## Plan
1. Root: add key resolver/validation and write-only global setting; async provider status callers await it. Preserve existing settings cache invalidation and admin boundary. Focused API/storage/provider tests before implementation.
2. Root: System card, form field and remove checkbox; public configured/source metadata only. Use existing page save, masked input, discard/reset logic; locale/docs update.
3. Root: focused checks, all offline tests/lint/format/build; isolated local server/browser smoke with synthetic key; final independent read-only review.

## Decisions
Reuse global settings as for proxyAuthSecret: no migration or new key-management infrastructure. Persisted DB/backups must be private, documented explicitly. No encryption claim. Environment remains a compatible fallback. Source metadata is admin-only; fit profile exposes only configured/model.
Rollback: revert source diff; remove the openrouterApiKey setting if needed (additive setting only). No schema changes.

## Progress
Clean main confirmed before edits; base 6a60ce7e1ce87c1ffcbb7ffb90f283f7e1c17f10. Dependencies were absent. Host Yarn 4 immutable install rejected the classic lockfile; removed only its generated .yarnrc.yml and installed successfully using Yarn 1.22.22 with frozen lockfile. No lockfile/package changes. No relevant Fredy memory entry found.

Implementation complete: pure resolver/validator in fit/providerConfig.js, write-only setting filtered at source, admin validation, awaited provider metadata on both fit profile endpoints, System card/form and all six locales/docs. Saved key overrides personal environment fallback; shared environment key never used. No migration needed.

Verification:
- Baseline focused fit/settings/admin: 82 PASS; baseline lint PASS.
- New API tests first reproduced missing behavior (9 FAIL, 1 PASS), then all focused 92 PASS.
- Final full offline suite: 5137 PASS, 33 skipped (389 files PASS, 1 skipped; /tmp/fredy-openrouter-offline-final.log).
- Full lint, formatting, diff whitespace checks PASS. Build PASS; dependency lottie direct-eval and Semi locale dynamic-import warnings remain.
- Actual isolated server on localhost:19998 with fresh DB and built frontend: admin login; POST key; GET settings shows source only; GET fit/profile configured true; blank save retains; explicit null removes; configured false. All PASS. No real provider key or network call used.
- Hook behavior 3 PASS: password cleared/dirty reset on successful save; discard cancels removal; saved removal sends null with no form-only field; rejected saves retain edits.
- Independent read-only plan review PASS; final source review PASS plus 38 independent focused tests; narrow final UI-test review PASS plus 3 independent tests. No unresolved source findings.
- Browser interaction/visual check NOT RUN: CUA explicitly returned "Local browser use is disabled in Work settings". No alternate UI automation attempted. Hook checks do not prove mounted controls/visual layout; disclose this verification gap.

Acceptance: A2/A3 PASS through persisted real storage/cache + consumer tests and isolated HTTP. A1/A4 implementation and API/hook checks PASS, browser evidence PARTIAL due environment restriction. No live paid provider test, commit, push, or deployment. Isolated server stopped after checks. Concurrent untracked work/autonomous-implementation/immoscout-account/ and apartment-search/remove-email.md appeared during this task and were left untouched.

## Release follow-through
User authorized commit/push/deployment. Concurrent unrelated email-removal edits overlap locales and docs; prepared an isolated detached worktree from base 6a60ce7 with only OpenRouter changes. Isolated lint/format/build PASS, full offline suite 5137 PASS/33 skipped, deployment recovery tests 11 PASS. Commit hook must run against this isolated snapshot. Existing worker will recheck immutable source, snapshot volumes, activate, and verify revision/auth/database integrity. Browser limitation remains disclosed.
