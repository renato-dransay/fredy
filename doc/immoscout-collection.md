# ImmoScout collection

Fredy reads ImmoScout Germany and Austria through their shared mobile JSON API. It does not start
Chromium for these providers and does not sign in to an ImmoScout account.

Each run starts on page one, sorted newest first, and follows the reported pages. Requests are
sequential, with 250 ms between pages and a 30-second timeout per request. Repeated pages, malformed
pagination, HTTP failures, or a search larger than 200 pages fail the fetch instead of silently
reporting a partial search. Narrow an exceptionally large search to stay within that bound.

Exclusive search results keep the portal's badge text and early-access deadline. The state is
refreshed on subsequent searches even for already-known listings, without announcing them again.
Badges appear in the grid, table and listing detail, with dates in the account's locale, and disappear
within one minute after expiry. Listing detail in MCP also reports the exclusivity and deadline.
An absent deadline means the portal did not specify one; it does not mean access is permanent.

Enable **ImmoScout** under the account's listing-details preferences to fetch descriptions and
galleries for newly found adverts. Detail requests are sequential, paced by 300–500 ms and time out
after 20 seconds. Existing listings can be enriched using their **Fetch details** action. Enabling
the preference does not repeatedly fetch descriptions for listings already stored.

A five-minute interval is reasonable for a small API-only search: four pages mean approximately
48 search requests per hour, plus details for new adverts. The initial catch-up costs more than
routine checks. The scheduler waits the configured interval after a scheduled run finishes and
prevents overlapping execution of the same job. This is an operational estimate, not an ImmoScout
rate-limit guarantee; reduce frequency if the provider starts returning HTTP 429 or blocking requests.

Anonymous responses currently include some adverts marked exclusive for Suchen+. This establishes
discovery of those adverts, not authenticated premium access, permission to contact an advertiser,
or complete coverage of prepublication/network offers. Those need a separate signed-in comparison.
