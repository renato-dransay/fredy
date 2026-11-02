# Private Mac Mini deployment

The fork's `main` branch is the delivery branch. The Mac Mini checks it every minute using Git transport; it does not require a public webhook, Funnel, or a privileged GitHub Actions runner. New first-parent commits are checked and deployed in order. Several commits arriving between polls are queued rather than silently coalesced. A failed check leaves the current service running and records the failure. A newer pushed fix can proceed; the failed revision is retained in the failure history rather than blocking its own repair forever. The latest failed revision retries no more often than every 15 minutes. A force-pushed main that is not descended from the deployed revision is rejected.

`mac_mini.py` runs lint, formatting, offline tests, and deployment tests in an isolated source snapshot, then builds an ARM64 image labeled with the exact commit. It stops the current application, verifies SQLite integrity, archives and compares both named volumes, and starts the replacement behind an activation gate. User mutations and all background schedulers remain paused until read-only revision, authorization, schema, and integrity checks pass.

A failure before activation stops the new writer and restores the verified snapshot. After activation, rollback preserves the database and outbound-send receipts: it changes code only. All migrations in this change are additive. Backups include the mail encryption key in `/conf`, so treat them as private. They are stored in a mode-0700 deployment directory, with mode-0600 archives.

## Installed operations

Machine configuration and logs live under `/Users/renas/.config/fredy-live`, outside Git. The worker is copied there only after a successful checked deployment, so ordinary edits cannot change the running worker. The LaunchAgent is `net.fredy.autodeploy`.

```sh
python3 /Users/renas/.config/fredy-live/mac_mini.py --config /Users/renas/.config/fredy-live/deploy.json status
python3 /Users/renas/.config/fredy-live/mac_mini.py --config /Users/renas/.config/fredy-live/deploy.json poll
launchctl print gui/$(id -u)/net.fredy.autodeploy
```

The worker serializes all commands with a lock. Deployment logs and verified snapshots are under `deployments/`; `deployment-state.json` records the served commit and previous image/Compose file. A failed check does not switch the live service. Do not restore snapshots after the service has accepted user changes or sent mail.

## Personal Jev key

An administrator can save a personal OpenRouter key in **Administration → System → OpenRouter (Jev)** without redeploying. It is write-only and stored unencrypted in SQLite, so keep the database and backups private. A saved key overrides the environment fallback. Removing the saved key restores that fallback if present.

Alternatively, supply `OPENROUTER_API_KEY_PERSONAL` through the deployment environment, never a shared/company key. Add it to the current Mac user's Keychain, entering it at the password prompt:

```sh
security add-generic-password -U -a "$(id -un)" -s OPENROUTER_API_KEY_PERSONAL -w
```

Then run `refresh` to recreate the current revision with the key injected from Keychain:

```sh
python3 /Users/renas/.config/fredy-live/mac_mini.py --config /Users/renas/.config/fredy-live/deploy.json refresh
```

With the Keychain/environment method, the key is not written into the repository, generated Compose file, logs, or database. Docker receives it in the container environment; administrators of the host/Docker daemon can inspect container credentials. The application reports configuration status without returning either key. Application tracking requires no mail credentials; sending and mailbox synchronization have been removed.

## Local verification

```sh
python3 -m unittest discover -s test/deploy -p 'test_*.py'
yarn lint
yarn format:check
yarn test:offline
```

The deployment tests inject snapshot, startup, activation, and postrelease failures. The live private URL remains `https://olympus.ibex-cobia.ts.net:9998`.

If recovery itself fails, the worker records `recovery_required` and stops all future deployments, including newer commits. Stop the LaunchAgent, preserve both volumes and snapshots, and inspect the failed deployment log before a deliberate recovery. This condition is different from an ordinary failed build/check, which leaves the current service running and permits a newer fix.

## Automatic deployment recovery

The installed `net.fredy.autodeploy` LaunchAgent must be loaded and enabled. `StartInterval=60` checks main once a minute, including after a failed poll; a slow build holds the deployment lock and later ticks leave it alone. A transient Git or test failure keeps the current service running. Inspect `autodeploy.log`, the revision's `deploy.log`, and `deployment-state.json` to distinguish an idle worker from a failed or disabled one.

A manually deployed source overlay must be integrated into main before normal Git deployment resumes. When `worktree_source_digest`, its manifest, or `automatic_deployment_hold` is present, the worker verifies that the candidate includes every approved change. Exact file hashes pass directly; authenticated source contents also permit unrelated newer main edits when a three-way merge with the recorded baseline changes nothing in the candidate. A missing, unreadable, malformed, inconsistent, or mismatching manifest blocks the release before checks or service changes. A successfully activated matching Git revision clears this temporary metadata. Do not disable the agent indefinitely or remove the hold without integrating the approved source.

The shared ARM64 check runner allows fixture setup hooks the same 60-second budget as individual tests. Assertions and all lint, formatting, offline, deployment, backup, authentication, and activation checks remain required.

## Browser auto-apply workers and deployment drain

Browser applications run in a separate worker; adding the code does not install a worker, pair an account, or enable a rule. See [the worker setup](../auto-apply/README.md) for its isolated dependencies, headed Chromium setup, and server/desktop environment. The worker connects outbound to the existing private Fredy API. Do not expose a Chromium debugging port or add public ingress for it. Pairing credentials are private, revocable credentials and must stay out of Git and deployment logs.

Server profiles default to `/conf/browser-profiles`, with isolated directories for each account connection. Mount that directory from the persisted Fredy configuration volume so the existing verified `/db` and `/conf` snapshot includes it. A host directory outside that volume needs its own private backup; the deployment snapshot does not discover external directories. Desktop profiles remain on that desktop and require a separately configured persistent directory and backup. Browser profiles contain authenticated sessions: protect the configuration volume and its archives as credentials. A restored profile may still require a new portal login.

Before stopping Fredy or taking a snapshot, the deployer sets the durable auto-apply drain flag inside an immediate SQLite transaction. This prevents new claims and submission authorizations. Server workers close their browsers and acknowledge profile closure. The deployer waits at most sixty seconds for active pre-submission leases and those acknowledgments; an old heartbeat is not evidence that a profile is closed. Explicitly disconnected server connections no longer participate in the drain.

Any `submitting` or `uncertain` run or durable receipt blocks deployment before the application is stopped and before a snapshot is taken, including when the source listing has been deleted or the worker lease expired. Inspect the portal history and reconcile the outcome in Applications. Do not erase a submission receipt or clear the drain just to force a backup. A worker that cannot acknowledge closure must reconnect and close its browser, or be explicitly disconnected after its browser has been stopped.

Failed drains leave the running application and its data in place, with browser automation paused. The deployment's normal retry observes the same drain without resetting existing closure acknowledgments. On success, automation resumes only after the replacement passes its activation checks. Recovery restarts the previous application before releasing the drain. After activation begins, rollback changes code only and preserves all submission receipts; it never restores an earlier database snapshot.

For diagnosis inside an application container, `node tools/auto-apply/drain.js status` prints only aggregate drain counts. The helper also accepts `request` and `release`; release changes only the drain flag and does not reconcile uncertain outcomes. The installed deployer embeds the helper operation so it can drain an older image that has no copy of this script. An installation with none of the auto-apply tables is treated as predating the feature; a partial schema fails closed.

After repairing and checking a worker, install it atomically at the existing operational path before re-enabling a stopped agent. Re-enable the existing schedule with:

```sh
launchctl enable gui/$(id -u)/net.fredy.autodeploy
launchctl bootstrap gui/$(id -u) /Users/renas/Library/LaunchAgents/net.fredy.autodeploy.plist
```

Use `bootstrap` only when the agent is not already loaded. Verify `launchctl print`, a successful scheduled deployment, the image's exact Git label and `/api/deployment` through the private HTTPS URL. Observe a subsequent scheduled poll to confirm it exits successfully without rebuilding an unchanged revision.
