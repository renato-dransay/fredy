# Persistent ingestion monitoring

Every scheduled or manually triggered provider run writes a receipt to `ingestion_runs` in the
normal SQLite database. It is always enabled after migration 61; debug logging is not required.
The persisted `/db` volume and ordinary database backups carry the history across container
replacements. Keep the database private, as for the rest of Fredy's data.

Read the live report without changing anything:

```sh
docker --context orbstack exec fredy-fredy-1 node tools/maintenance/ingestion-status.js
# Or inspect a local database/snapshot:
node tools/maintenance/ingestion-status.js --db /absolute/path/listings.db
```

The JSON report lists **every enabled source of every enabled job**, its latest receipt, its age,
and 24-hour run/failure/insert totals. Exit code 1 indicates failed, interrupted, overdue or missing
runs; 2 means monitoring could not be read. A normal running receipt is not yet a successful run.
A run becomes overdue after three configured intervals or 15 minutes, whichever is longer, while
inside the configured working hours. This is an operational threshold, not an assertion that a
slow provider has failed. Outside working hours old completed runs are not flagged overdue.

Receipts have these outcomes:

- `running`: provider setup, browser startup or ingestion has not finished.
- `success`: the pipeline reached completion.
- `no_new`: a normal empty/duplicate/filtered result stopped the pipeline. This can follow inserts
  if later eligibility, similarity or notification filters remove everything.
- `failed`: provider setup/browser or the pipeline failed. A partial provider response explicitly
  marked incomplete is also failed, even when its usable listings were saved.
- `interrupted`: the application restarted before a receipt was finished. Recovery runs only when
  the main scheduler initializes; the status reader and MCP never mark live runs interrupted.

`fetched` counts raw provider results, `stored` counts genuinely inserted rows (not conflict
updates), and `matched` counts distinct saved listings surviving similarity and search-area
filtering before later commute/notification rules. These are different funnel stages, so a stored
row does not necessarily become a visible result or a notification. Optional detail/fit/travel-time
and other enrichment failures increment `warnings`; completed runs with warnings report degraded
health. A generic scraper page with no matching listing cards is also degraded because an empty
search and a changed selector cannot be distinguished; a missing page response is failed. Receipt success does not certify that a notification reached an external recipient.

Only internal stage names, numeric counts, and fixed error categories are stored. Exception text,
search URLs, response bodies, and credentials are excluded. Incomplete provider responses with a
known HTTP status retain `access_denied` (401/403), `rate_limited` (429), or `upstream_error`
(5xx); other incomplete responses retain `provider_incomplete`. Stages are retained on completion;
a running receipt records the initial setup stage, not a live progress heartbeat.

The latest 20,000 completed receipts are retained, up to 30 days. In-progress receipts are retained
until completion or restart recovery. Job deletion cascades to its receipts. Monitoring write
failures emit a generic warning and never prevent ingestion; a missing or stale receipt must not
be interpreted as proof of success. No historical run outcomes are reconstructed, and no external
alert or recurring chat notification is configured by this feature.
