# Applying a search profile across portals

A saved apartment profile describes what makes a flat suitable. A job's portal URLs, shared
specifications and drawn area decide what is collected. Keep the hard numeric constraints aligned
in both places; two bedrooms are a layout requirement, not proof supplied by a total-room count.

In **Settings → Apartment profile → Automatic fit assessments**, explicitly select the jobs you
own and save. This enables personal-provider usage for new listings found after activation, not a
paid backfill of previous inventory. Deselecting a job stops new automatic calls. A shared job or
someone else's channel never receives your private fit classification.

New candidates are assessed after details and shared filters. A batch handles up to 20 candidates,
with at most four simultaneous evaluations across manual and automatic requests. Remaining
unassessed candidates continue on later job runs, including after a restart. Unchanged saved
assessments are not automatically repurchased. Provider outages leave the listings intact and
back off that job for fifteen minutes. A failed assessment never replaces an earlier receipt.

Private owner-only notification channels for unshared jobs distinguish **meets requirements**,
**does not meet requirements**, **needs clarification**, **assessment pending**, and **assessment
unavailable**. No notification includes the private requirement text, evidence or reasons.
Failed and uncertain candidates remain in Fredy; a score cannot override a failed must-have.

Missing dog permission, bedroom layout or lease terms remain unknown. Likewise, a portal's cold
rent or running charges do not establish the Warmmiete including heating. The evaluator receives
labelled charge and energy data alongside listing text without assuming a complete rent breakdown.

For actual walking evidence to any U-Bahn/subway line, use a **station-line** criterion with line
`*` and a walking limit. Named lines such as `U2` still work. The wildcard checks subway route
membership and walking routes; nearby S-Bahn/tram stops and straight-line distance do not establish
the preference. Unavailable station data, routing or coordinates produce unknown.

Add portals to the same job to retain cross-provider deduplication. Keep a shared minimum area,
room-count heuristic and drawn polygon; choose each portal's supported search filters explicitly.
A headline-price ceiling is a coarse search bound when a portal quotes cold rent, not evidence
that the all-in budget is met. Preserve the original portal URL and use a closed GeoJSON polygon
for the equivalent Fredy area. Source entries with `enabled: false` do not run.

OhneMakler detail enrichment retains the search-card identity and price while adding the advert's
description, labelled facts and gallery. Missing, unavailable or wrong-ad pages preserve the
original card. No portal login or application submission is performed by this workflow.
