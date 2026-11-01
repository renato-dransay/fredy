# Apartment search delivery

User authorization: implement discussed capabilities with Jev, push to main, redeploy, and deploy on every main push. User will configure provider credentials after delivery; live paid Jev/SMTP/IMAP calls without those credentials are explicitly deferred. No messages to real landlords as implementation tests.

Base: 54e6b3d58deb56a0ca5faeea194338365b52cfc1, clean master, fork renato-dransay/fredy. User requests main: create main from current commit and make it the deployment branch. Preserve master/upstream.
Risk: high (private applicant data, outbound mail, schema changes, deployment). Read review and decision protocols. No PR requested: direct main push after independent reviews and required checks.

## Acceptance contract
A1 User-scoped apartment requirements profile accepts pasted text or text/Markdown document, with editable criteria, hard requirements/weights and explicit bedroom vs rooms semantics; no invented extracted facts.
A2 On-demand Jev assessment returns met/unmet/unknown per criterion, confidence, source references, weighted score, hard-failure and coverage indicators; persists provenance, invalidates on evidence/profile changes, never treats unknown as a match. No key => clear not-configured state; provider errors finite and sanitized. Numeric budget/size/rooms checked directly. U2 proximity supports a specific station via existing walking-time destination and clearly distinguishes any-U2 matching; implement line-aware distance lookup if feasible from existing transit APIs, otherwise unknown rather than pretend.
A3 Per-user per-listing application record with draft/submitted/replied/visit_scheduled/follow_up/rejected/accepted/withdrawn, timeline, correspondence notes, visit times and follow-up dates. Due actions surfaced, visit downloadable ICS with safe escaping.
A4 Personalized letters reuse Fredy's templates/profile. Copying is a draft, never submitted. SMTP send with explicit recipient/review, confirmation from transport before marking submitted, idempotency and ambiguous-result handling that prevents blind duplicate sends. Optional automatic application uses explicit per-listing opt-in with a fixed reviewed recipient/body. It must never infer permission from listing or model content.
A5 Replies can be recorded manually and ingested automatically using configured IMAP, matched only by recorded outbound Message-ID/In-Reply-To/References, without unsafe fuzzy cross-user matching. Missing credentials shown as setup requirements. Polling/retry dedup and bounded payloads; user-scoped mailbox configuration.
A6 Usable UI: profile page, fit result on listing, application tracker/timeline/visits/follow-ups and inbox sync/setup status. Both themes/responsive layout follow existing tokens; no secrets serialized.
A7 Required lint/format/offline suite and meaningful negative API/isolation/provider/retry tests. Baseline 5 routingSettings failures (users table absent), 5032 pass/33 skip, from original deployment log; reproduce/check and fix fixture if needed for an honest green gate, without weakening assertions.
A8 Build image from committed main, backup database before migration, preserve configuration/data and Tailscale routes, verify exact revision, HTTPS/login, migration integrity and new flows. Rollback preserves predeployment snapshot.
A9 Auto deployment observes origin/main using a private Mac Mini pull worker, deduplicates commits, serializes deploys, builds and checks before switch, records actual deployed SHA, keeps previous image/DB snapshot. Polling avoids public hooks or privileged GitHub runners. Test trigger with a genuine subsequent main push. Persist via LaunchAgent and provide status/log/stop commands.

## Design and ownership
Extend existing Fastify, SQLite, React, templates, transit services. Dedicated authenticated routes /api/fit and /api/applications; add only additive migrations 54 (fit), 55 (application workflow). Profile/fit results and application state private to the current user even when listings are shared. Use existing userCanAccessListing for source access; recheck after async calls before persisting. Don't reuse global listing status as per-user workflow state.
Jev: OpenRouter Decisions API https://openrouter.ai/api/alpha/decisions, pinned typesafe/jev-1.14, credential OPENROUTER_API_KEY_PERSONAL only from deployment environment/Keychain; no shared credential fallback. Evidence strings are untrusted data. Jev makes finite decisions, not free-form explanations; UI shows source text and deterministic explanation labels.
Mail: use existing nodemailer dependency, add IMAP client only if necessary, separate user mail config encrypted at rest with master secret under persistent /conf. Never return passwords; operator/local host has access to deployment secret material. For UI credential setup use password inputs, update/clear semantics and sanitized connection checks.
Deployment: host-controlled poller (launchd, git fetch origin main), scripts stored in fork plus machine-specific config outside checkout. Isolated staging checkout for build so live repo edits cannot contaminate a revision. No public Funnel.

## Tasks
T1 Plan challenge, establish dev container baseline and external API contracts.
T2 Fit backend + tests (agent fit); owns lib/services/fit/**, lib/api/routes/fitRouter.js, migration 54, test/fit/**.
T3 Applications backend + tests (agent applications); owns lib/services/applications/**, lib/api/routes/applicationsRouter.js, migration 55, test/applications/**. Coordinate dependency addition with root; no edits to shared api.js/index.js.
T4 UI (agent ui); owns new ui fit/workspace components/pages/client, App.jsx/SettingsLayout.jsx/ListingDetail.jsx/navigation/ApplicationModal and UI tests. Root wires authenticated routes and starts application scheduler.
T5 Root integration/dependencies/deploy scripts/CI/documentation; review chunks then integrated read-only independent review.
T6 Full checks, staging/browser acceptance, commit/push main, production backup/redeploy verification, install/verify main-push poller.

## Progress
- Contract/design prepared; personal provider key missing and explicitly deferred by user until after delivery.
- GitHub REST currently rate-limited; Git transport works. Use GraphQL or wait only where repository settings require API.

Plan review PR-01..04 accepted and resolved in api-contract.md: concrete API shapes, stopped-writer whole-volume verified snapshots and rollback, actual U2 line lookup required, durable ordered first-parent commit deployment rather than coalescing. User explicitly defers all provider setup to after implementation; no more key setup requests this run.
Plan PASS after final PR-02 activation boundary accepted: block mutations and pause all schedulers before acceptance; preactivation failure may restore snapshot; postactivation rollback preserves DB/send receipts. root owns lib/services/deploymentGate.js and api.js/index.js wiring.

Chunk evidence: baseline lint + offline5037pass/33skip (fresh dev); isolated routing-settings fixture now mocked demo provisioning to remove baseline ordering dependence,13pass unchanged assertions. Fit44tests pass and scopedlint/format; applications21tests pass and scopedlint/format; frontend focused46tests +lint+Vitebuild pass (full locale/UI closure pending). Deployment6Python failure-boundary tests+3runtimegate tests pass. Fresh independent review running against actual integrated files. All provider live calls user-deferred.

## Review dispositions
IR-01 accepted: gated API reads now audited allowlist; legacy image/routing GETs503 before activation;4gate tests pass.
IR-02 accepted: stationunknown retry TTL60s, reuse unchanged semantic receipt with original24h age;46fit tests pass.
IR-03 accepted: application revision serialized and expectedRevision required/atomicallychecked; stale-reviewed-draft test verifies no transportcall.
IR-04 accepted: deployment state reloaded underflock; main fetched into refs/fredy/main to avoid sharedFETCH_HEAD races. Python state-concurrency test passes.
Verification amendment: isolated fault writes independent marker AFTER changing syntheticDB, then exits42; verified snapshot restore returns originalsentinel and SQLiteintegrityok. Only disposable uniqueproject volumes mounted; production nevermounted by fault test.
Queue recovery: each unseen first-parent maincommit attempted in order. Failedchecks retainreceipt/backoff15min and do not block subsequentfixcommit;9Python tests pass. Allsource passed independentread-only review; finalqueueamendment review pending.
Browserstaging: profile save, application manualnote, numericfit100/100 withsourceevidence, reply and visit/followup display; APIisolates profiles and workflow acrossusers sharinglisting; visitICS valid; noJeVkey ->503notconfigured; nosmtp/imap ->explicitsetup. Noexternalmail sent. Screenshot outsideGit in .config/fredy-live/workspace-browser.jpg.
Currentintegratedchecks: lint0warning0error, allformatcorrect, offline5120pass33skip, productionVitebuildpass. Log .config/fredy-live/integrated-checks-20261101.log. Oldbaseline5fixturefailures not hidden: currentroutingfixture mocks demo-account provisioning,13assertions pass independently; fullbaseline5037pass in currentdev.
Finalqueue-reviewfinding accepted/closed: distinguish ordinary failedchecks from unresolvedruntime recovery. RecoveryError abortsqueue, persistsrecovery_required, blocksallfuturedeploys untiloperatorrecovery;11Python tests independentlypassed. No unresolvedsourceblockers beforecommit.

## First main deployment verified
- Pushed c6f63282afe367c2e966f42829bcbe07f4ae5916 to origin/main and set GitHubdefaultbranch main. GitHub sourcecheck and Tests both success. No PR was opened/requested.
- Installed net.fredy.autodeploy LaunchAgent (RunAtLoad,60s). It independently fetched main, checked immutablearchive, built ARM64image and activated c6f6328. No manualdeploy command used.
- Verified containerhealthy, OCIrevisionlabel c6f6328, HTTPS/api/deployment exactfullSHA+active=true. Adminlogin and securecookiepersisted, olddefaultpasswordrejected, configuredbaseURL/analytics/timezone preserved. New fit/application/mail endpoints authenticated/readable. Currentuserprofile remainsunconfiguredversion0; no testpreferences or applicationdata insertedinto production.
- Verified snapshot at .config/fredy-live/deployments/1793530075-c6f63282afe3/backup, priorimage54e6b3d retained. AllTailscale exposure remainsprivate on9998.
- Controlled providers cover Jev responses/SMTPacceptance/failure/IMAPmatching; realprovidercredentials+liveprovidercalls deferred by explicituserrequest. PublicOverpassliveprobe timedout and returnedunknown correctly; no claim of a successful live U2 route. TextMarkdown and email-only submission limitations documented.
- Browserstaging savedrequirements and applicationnote through actualUI, fit100/100 with sourceevidence displayed. Productionread-onlynewendpoints verified. No real outboundmessages sent.
- Added4timer-level scheduleracceptance tests (activation gate, reviewedrevision, nooverlapping tick, failedscheduleclear, five-minuteinboxcadence); allpass. Runtimecodeunchanged fromreviewed/deployedc6. This test/evidencepush will verify a genuinely subsequentmain-push trigger.

## Acceptance status
A1 PASS text/Markdown andeditablecriteria UI/API persistence.
A2 PASS deterministicactualAPI, typedJev controlledtests, unknown/recovery/stale/privateprofile; livepaidprovidersetup user-deferred.
A3 PASS timeline/manualreply/visit/followup/ICS and shared-listingprivateworkflow actualAPI+UI.
A4 PASS controlledtransport/scheduledentrypoint/idempotency/uncertainoutcome, copyneverclaimsapplied; actualSMTPsetup user-deferred.
A5 PASS controlledIMAPexactmessageID/cursor/dedup/configisolation; actualmailboxsetup user-deferred.
A6 PASS sixlocales+boththemes/styleschecked, browserUI/profile/applicationflow.
A7 PASS full5120/33skip+4newtargetedtimerchecks, lintformatbuild,11Pythonrecovery/queuechecks; immutablearchivegate also passedfirstdeployment.
A8 PASS firstmainpush+actualdeployment/exactservedSHA/persistentlogin+settings and verifiedrollbacktest.
A9 LaunchAgentandfirsttriggerPASS; subsequentrealpush verification pending.
