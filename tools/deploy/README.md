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

With the Keychain/environment method, the key is not written into the repository, generated Compose file, logs, or database. Docker receives it in the container environment; administrators of the host/Docker daemon can inspect container credentials. The application reports configuration status without returning either key. SMTP/IMAP credentials are entered separately in the Applications page and encrypted in SQLite with the private key in `/conf`.

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

After repairing and checking a worker, install it atomically at the existing operational path before re-enabling a stopped agent. Re-enable the existing schedule with:

```sh
launchctl enable gui/$(id -u)/net.fredy.autodeploy
launchctl bootstrap gui/$(id -u) /Users/renas/Library/LaunchAgents/net.fredy.autodeploy.plist
```

Use `bootstrap` only when the agent is not already loaded. Verify `launchctl print`, a successful scheduled deployment, the image's exact Git label and `/api/deployment` through the private HTTPS URL. Observe a subsequent scheduled poll to confirm it exits successfully without rebuilding an unchanged revision.
