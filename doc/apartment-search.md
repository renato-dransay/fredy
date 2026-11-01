# Apartment fit and applications

## Your apartment profile

Open **Settings → Apartment profile**. Paste your requirements or import a text/Markdown document, then edit the criteria. Mark must-haves, set preference weights, and use structured price, total-room, floor-area, or metro-line walking-time rules where appropriate. A bedroom is not the same as a total room; bedroom layout, kitchen size, furnishing, and lease duration should use semantic criteria supported by the listing's actual text.

On a listing, **Evaluate fit** runs deterministic checks and, when configured, Jev through the personal OpenRouter Decisions API. Every criterion is met, unmet, or unknown. The result shows supporting source excerpts, confidence, evidence coverage, hard failures and unknown must-haves. Unknowns receive no fit credit. The overall score cannot override a failed must-have. Changing the profile or listing makes older results stale.

Metro-line criteria look for actual matching route membership in OpenStreetMap and calculate walking routes to candidate stops. They do not mistake the nearest generic stop for a U2 stop. Missing coordinates, incomplete map data, or unavailable routing produce unknown. These are evidence checks rather than guarantees of physical accessibility. Only text/Markdown profiles are supported; uploaded listing PDFs/photos remain attachments and are not OCR inputs for fit.

Semantic analysis requires a personal OpenRouter key. An administrator can set it in **Administration → System → OpenRouter (Jev)**. The password field is write-only: leave it blank to retain the saved key, enter a new value to replace it, or select **Remove saved key** and save to remove it. The saved key takes effect immediately and overrides `OPENROUTER_API_KEY_PERSONAL` from the deployment environment. Removing it restores that environment fallback, if present; the status indicates the active source. Fredy never uses the shared `OPENROUTER_API_KEY`.

The UI-saved key lives in the global SQLite settings alongside other instance secrets. It is not encrypted at rest; restrict access to the database and backups. No API response returns it. Without a key, the app explains the missing setup; numeric-only profiles remain usable. No claim of a live provider test is made by the installation tests.

## Applications, replies, visits and follow-ups

Open **Applications**, or the tracker on a listing. Application state and correspondence are private to your account, including when the source listing is shared. Save a draft using Fredy's existing applicant profile and templates, enter the recipient, and review the subject/body. Copying a letter no longer records a submission.

Track draft, submitted, replied, visit scheduled, follow-up, rejected, accepted, and withdrawn. Record notes and replies, set viewing/follow-up times, download an ICS appointment, and see due actions in the application list. Manually recorded status changes are labeled separately from transport receipts.

With SMTP configured, send a reviewed draft or opt that fixed draft into a scheduled send. This is email delivery only; it does not log into or submit forms on real-estate portals. Recipients are explicitly supplied by you. It does not automatically apply to every new listing or infer permission from a fit score. A successful SMTP acceptance records submission; it does not guarantee delivery or a landlord response.

Each dispatch reserves a durable outbox entry before contacting SMTP. Repeated clicks cannot duplicate a send. A crash or network timeout after possible acceptance is shown as uncertain and is never blindly retried. Check the mailbox before explicitly resolving the uncertain delivery.

Configure IMAP to synchronize replies automatically or use **Sync inbox**. Only messages referencing an outbound Message-ID recorded for your own account are attached to applications. Unmatched messages are ignored, not guessed from their subject or sender. Manual reply recording works without IMAP. Mail credentials are encrypted in the database; backups must include the configuration volume containing the encryption key. Configure mail on the Applications page after deployment; installation verification uses controlled transports and sends nothing to real landlords.

Automatic deployment and recovery instructions: [Mac Mini deployment](../tools/deploy/README.md).
