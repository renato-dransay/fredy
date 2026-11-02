# Private browser application worker

The worker uses pinned Stagehand 4.3.0 and system Chromium. It is a separate Node process: scraper sessions, cookies and tabs are never reused. It only makes outbound authenticated requests to Fredy; no browser-debugging or viewer port is published.

## Install and pair

Use Node >=22.22, install Chrome/Chromium, and run `npm ci --prefix tools/auto-apply`. Create a browser connection in Fredy's Application settings, copy the one-time worker token into a mode-0600 file, and run:

```sh
FREDY_URL=https://your-private-fredy-host \
FREDY_WORKER_TOKEN_FILE=/private/path/worker-token \
FREDY_BROWSER_PROFILE_DIR=/private/path/browser-profiles \
node tools/auto-apply/worker.js
```

`CHROME_PATH` can select a Chromium executable. Profile directories are isolated by user and connection, mode 0700, and must persist. Treat them and their backups as credentials. Do not place them in Git, a public file share, or a disposable container layer. The desktop fallback uses the same command with its own paired connection and profile; it does not copy an existing personal browser's cookies.

Open the browser from Fredy, sign in directly, and enter the account identity visible in the portal's header/profile navigation. **Verify login** closes and reopens the browser and verifies that identity again. Then enable agent control. No model observes the login/password/2FA flow. Screenshot and keyboard relay data is ephemeral and available only through the authenticated connection UI.

The browser worker runs the initial application only. Missing required answers, legal/payment commitments, unknown write endpoints, unsupported external portals, and incompatible selected files pause the run. Site changes fail closed. A login verification establishes session persistence, not proof that application sending works. ImmoScout24, Immowelt and Kleinanzeigen adapters have fixture contracts; each real portal still requires a verified enabled-rule application receipt before claiming live qualification.

## Server container

Build from the repository root with `docker build -f tools/auto-apply/Dockerfile.worker -t fredy-auto-apply .`. Run the image on the private Fredy network, with the token file mounted read-only, the existing conf volume's `browser-profiles` directory persisted at `/conf/browser-profiles`, and no published ports. Supply an HTTPS Fredy URL. The supplied `compose.yaml` mounts the existing external conf volume at `/conf`. Set `FREDY_CONF_VOLUME` to the actual conf volume recorded by the installed deployment, plus `FREDY_URL` and `FREDY_WORKER_TOKEN_FILE`, then run `docker compose -f tools/auto-apply/compose.yaml up -d --build`. Its one-shot init service creates and changes ownership only of `/conf/browser-profiles`; it does not change other conf data. Never use `compose down -v` to retire this worker.

The container runs Chromium as the non-root `node` user under Xvfb; keep Chromium's sandbox enabled. Browser profiles must be writable by uid 1000. Default to one worker/application and allocate at least 2 GB memory to the worker.

Compose supplies `seccomp_profile.json` to permit Chromium's own namespace sandbox. It preserves the [Moby default profile at commit `4b8214fc4971e06172938a1f1554ccff6647ee80`](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json) and adds only an unconditional `SCMP_ACT_ALLOW` rule for `clone`, `setns` and `unshare`, following [Playwright's sandbox guidance](https://playwright.dev/docs/docker#crawling-and-scraping). All other baseline rules remain unchanged. To reproduce, parse that pinned JSON, append the three-name rule to `syscalls`, and serialize it; whitespace is immaterial. The upstream Apache-2.0 license is retained in `LICENSE.seccomp`. A direct `docker run` must also pass `--security-opt seccomp=tools/auto-apply/seccomp_profile.json` from the repository root. Do not replace this with an unconfined profile, privileged container, or `--no-sandbox`.

Normal shutdown asks Chromium to close and waits for its process to flush cookies and local storage before final SDK process cleanup. A disconnected browser guard uses immediate process cleanup instead. Login verification still checks the actual portal session after restart; preserving a profile cannot guarantee that a portal will accept an expired session.

For desktop mode the visible window can also be operated directly. Agent control must be paused first; direct user actions during an uncertain submission must be reconciled in Fredy before any new attempt.

## Submission and recovery

The finite-action agent can only fill saved facts, open contact controls, stage selected documents and request the designated Send action. A separate browser-wide CDP request barrier blocks unclassified writes and pauses new tabs before execution. Final submission requires a durable intent followed by a fresh, single-use authorization consumed while the final HTTP request is paused at the network barrier; only one matching request may pass. The saved message and advert identity must match the request. Confirmation requires both a successful authorized request and a new portal success marker, not the model's claim.

A transport/authentication failure closes browser sessions. Deployment drain also closes all profiles and acknowledges closure before the conf-volume snapshot. Do not snapshot an open profile or restore old submission receipts over a database that has accepted applications. Uncertain sends are never automatically retried.

Local Chromium qualification tests (no external portal traffic or paid inference):

```sh
TEST_MODE=offline TEST_AUTO_APPLY_BROWSER=1 npx vitest run test/autoApply/browser*.test.js
```
