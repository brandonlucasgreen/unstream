---
status: Done
---
# Unstream Releases — V1 scope, locked

**Written:** 2026-07-31
**Supersedes:** the phasing in `music-sindy-spec.md` and §5's open questions in `unstream-releases-design-review.md` (which remains the reasoning behind these choices)
**Scoped by:** Brandon, 2026-07-31

To do:
- refresh this scope doc based on what’s built
- get Mirlo api working
- Confirm whether Discogs or MB is working
- Look into iTunes search api

---

## Current state — updated 2026-07-31 (evening)

**Steps 0–4 are shipped and deployed, and cataloging is running in production for the first
time.** After seeing Bandcamp-only results looking like an undifferentiated copy of Bandcamp
itself, the plan skipped ahead: **steps 7 and 8 (Discogs + MusicBrainz enrichment, and dedup
tiers) are now implemented in this branch**, out of build order but for a real reason — a
second and third source is what makes a release page look like Unstream's own product rather
than a Bandcamp mirror. Steps 5 and 6 (alerts, feeds) remain the next payoff work once this
lands.

| Step | Status | PR |
|---|---|---|
| 0 · `check-releases` hardening | ✅ merged | [#355](https://github.com/brandonlucasgreen/unstream/pull/355) |
| — · Bandcamp grid parser *(prerequisite)* | ✅ merged | [#357](https://github.com/brandonlucasgreen/unstream/pull/357) |
| 1 · Schema + `release-utils` + tests | ✅ merged | [#356](https://github.com/brandonlucasgreen/unstream/pull/356) |
| — · Shared `safe-fetch` module *(prerequisite)* | ✅ merged | [#358](https://github.com/brandonlucasgreen/unstream/pull/358) |
| 2 · Demand-driven ingest queue | ✅ merged | [#359](https://github.com/brandonlucasgreen/unstream/pull/359) |
| 3 · Bandcamp catalog ingest — grid | ✅ merged | [#359](https://github.com/brandonlucasgreen/unstream/pull/359) |
| 3b · Bandcamp release detail — **dates, formats, prices** | ✅ merged | [#360](https://github.com/brandonlucasgreen/unstream/pull/360) |
| 4 · Release page | ✅ merged | [#362](https://github.com/brandonlucasgreen/unstream/pull/362) |
| — · `npm run catalog:artist` CLI | ✅ merged | [#365](https://github.com/brandonlucasgreen/unstream/pull/365) |
| — · Releases on the artist page | ✅ merged | [#366](https://github.com/brandonlucasgreen/unstream/pull/366), rebuilt in [#370](https://github.com/brandonlucasgreen/unstream/pull/370) |
| — · Admin "Catalog releases now" button | ✅ merged | [#370](https://github.com/brandonlucasgreen/unstream/pull/370) |
| — · Production gate fix | ✅ merged | [#372](https://github.com/brandonlucasgreen/unstream/pull/372) |
| **5 · Alert rewiring + Mac bug fix** | ✅ **built 2026-08-01 (evening), unmerged** — catalog-backed alerts; defects 1,2,3,4,7 fixed, 5 partial, **6 not done** — see below | |
| 6 · Per-fan feeds | ✅ **built 2026-08-01 (evening), unmerged** — token ICS + Atom, plus public handle and artist feeds | |
| **7 · Discogs + MusicBrainz enrichment** | 🟡 **built on branch `releases-discogs-musicbrainz-307d54`, not yet merged/deployed** | |
| **8 · Dedup tiers (1–2 automated, 3 queued)** | 🟡 **built alongside step 7 — see below**, not yet merged | |
| **9 · Artist curation UI** | 🟡 **built 2026-08-01, unmerged** — review/hide, merge, fix, add | |
| 10 · Mirlo, then Subvert / Jam.coop | ✅ **closed 2026-08-01 (evening)** — Faircamp + discovered links earlier; **Jam.coop built**; Mirlo still robots-blocked, Subvert still unfetchable — see below | |

### Steps 7 + 8, built 2026-07-31 — what's actually there

Unmerged, on branch `releases-discogs-musicbrainz-307d54`. Build, typecheck, and the full test
suite (api + web unit) all pass; nothing has been deployed or exercised against production data
yet.

**Discogs** rides along after Bandcamp in the same per-artist catalog run (`catalog-artist-background.ts`),
using the artist's stored Discogs link (`extractDiscogsArtistId`, already live in
`api/search/enrichment.ts`). Same two-tier shape as Bandcamp: a cheap paginated listing from
`GET /artists/{id}/releases`, filtered to `role: Main` + `type: master` (Discogs' own "these
pressings are one album" grouping — the dedup identity layer §10 called for), then a budgeted
detail pass over the newest masters (capped at 5/artist, 30 requests/invocation, paced at
~23/min against Discogs' 25/min unauthenticated ceiling) reading `GET /releases/{main_release}`
for date, format, and marketplace price/availability. `api.discogs.com` is now on the SSRF
outbound allowlist (`api/functions/middleware.ts`) alongside the existing `discogs.com` /
`www.discogs.com` entries used for social-link scraping.

Two things worth knowing about the Discogs offer data specifically: **it's one offer per
release, not per format** — `num_for_sale`/`lowest_price` describe the whole marketplace
listing, not a per-format breakdown, so quoting the same aggregate price against every format in
a multi-format pressing would misrepresent a bundle. And **zero current listings reports as
`unknown`, never `sold_out`** — "sold out" implies stock existed and ran out, which zero
listings doesn't establish. No payout percentage is asserted for Discogs (the registry entry
already had none) — secondhand pays the artist nothing and new-stock label accounting is
unknowable from the API, exactly as this doc concluded.

**MusicBrainz is enrichment-only, on purpose.** It searches by artist name (reusing the same
match-confidence guard as `search-musicbrainz.ts`: score ≥ 95, name similarity check), then
fetches release groups and merges in release-group MBIDs and dates (at whatever precision
MusicBrainz actually has — year-only and month-only are common) into releases that already
exist. **It never creates a new release row** — MusicBrainz has no purchase link to offer, and
a release page with a date and nowhere to buy it would be worse than not having the page.

**Dedup (step 8) landed as three tiers, matching §4 exactly:**

- **Tier 1 — hard identifiers.** `discogs_master_id` and `musicbrainz_release_group_id` (both
  already in the step-1 schema, unused until now) are checked first on every persist. A
  re-crawl updates in place rather than creating a duplicate.
- **Tier 2 — exact match within type.** Falls back to `(release_type, match_key)` when there's
  no hard identifier yet, same as Bandcamp's own dedup — but now guarded so a tier-2 candidate
  that already carries a *different* hard identifier is refused (that would mean the title
  match is coincidental, not the same release).
- **Tier 3 — fuzzy, never merged.** New helper `isFuzzyReleaseMatch` (in `release-utils.ts`)
  flags one match key as a probable variant of another — the motivating case is a title plus
  its `(Deluxe Edition)`/`(Remastered)` reissue — via containment plus a length-ratio floor.
  It **never merges anything.** It inserts a new row and sets `needs_review = true` on both
  sides, which is exactly the admin-queue backstop §4 and §11 called for. There is still no UI
  to review the flag (that's step 9, deliberately deferred) — for now it's a signal sitting in
  the database, visible via a direct query.

Both sources are independent of Bandcamp and of each other: a Bandcamp bot challenge no longer
prevents Discogs/MusicBrainz from running in the same invocation, and only counts as a run
failure (against the backoff counter) when nothing came of the run at all.

**Not done as part of this pass:** wiring `needs_review` into any UI, Mirlo/Subvert/Jam.coop, and
steps 5/6 (alerts, feeds) — all still open per the table above.

### The admin review queue, built 2026-08-01

The UI the previous section flagged as missing. New migration adds
`releases.flagged_against_release_id` — a nullable self-reference recording *which* release a
tier-3 fuzzy match was flagged against, since the original write only set `needs_review = true`
with no way to reconstruct the pair later. `persistDiscogsReleases` now writes both sides of that
pointer at flag time.

`/admin/release-review` (mirrors `/admin/verify`'s auth and layout conventions exactly) lists
every flagged pair — deduplicating the symmetric A-flagged-against-B / B-flagged-against-A rows
into one entry to review, not two — and offers exactly the two answers spec §4/§11 call for:

- **"Not a duplicate"** — clears the flag on both sides.
- **"Same release — keep this one"** (one button per card) — moves every source off the
  dropped release onto the kept one, fills in whatever the kept one was missing (date, artwork,
  never overwriting a curated field), then deletes the now-empty duplicate. Sources are moved
  **before** the delete, and the delete only runs once that succeeds — this project already lost
  data once to the reverse order (PR #350), so the merge follows the same discipline. A same-
  platform conflict between the two releases refuses the merge outright (409, with the platform
  named) rather than silently dropping one side's source.

A pair whose counterpart is no longer on file (resolved from the other side, or since deleted)
still shows — the flagged release, alone, rather than disappearing, since something about it was
ambiguous enough to flag in the first place.

Artist-facing curation (§11) landed the same day, on `/artist-edit/:slug/releases` (linked from
the profile editor), backed by a new ownership-checked endpoint (`api/functions/artist-releases.ts`)
following the same "service role + server-side check, no RLS" convention `artist-profile.ts`
already uses. All three capabilities from §11's priority list:

1. **Review/hide** — every release under the artist, including hidden and `needs_review` rows
   the public page never shows.
2. **Merge duplicates** — reuses the admin queue's own `mergeReleases`/`dismissReleaseReview`,
   gated by a new `verifyReleaseOwnership` check (an artist owning *a* profile doesn't mean the
   release ids in their request are *that* profile's — this has to be checked per id, not just
   per slug).
3. **Fix and add** — correct title/date/artwork (via `curated_fields`, same mechanism), add a
   missing platform link, or add a release ingest never found.

One real gap this surfaced and fixed: ingest had no concept of a artist-corrected
`release_sources.url` — a re-crawl would have silently reverted a fix in 30 days. Sources added
or corrected via curation are written `source: 'claimed'`, and `persistReleases`/
`persistDiscogsReleases` now both check `getClaimedSourceKeys` before ever touching a source's
URL — the same never-clobber-a-curated-edit rule `curated_fields` already enforced on the
release row, extended to the sources table.

### Step 10, revised: Mirlo paused, Subvert confirmed dead, Faircamp built instead

**Mirlo — paused, not abandoned.** Its API is genuinely excellent for this: one request
(`GET /v1/artists/{slug}`) returns an artist's full discography, with price, currency,
`isPreorder`, and cover art all in the same payload — no second "detail" request needed, unlike
Bandcamp or Discogs. But `api.mirlo.space/robots.txt` explicitly disallows `/v1/` for every user
agent, under a human-written `# Disallow crawling the API` comment. Per this codebase's own rule
("check robots.txt before adding a scrape, and honor it"), ingest work stopped before it started.
**Brandon is in touch with Mirlo's dev team directly and will raise it with them** — this is the
right way to resolve it, not a workaround.

**Subvert — confirmed a hard technical wall, not a policy question.** Tested directly rather
than assumed: fetching Brandon's own known-good Subvert URL
(`https://www.subvert.fm/kid-lightbulbs`) returns HTTP 429, a Vercel bot-challenge page, for
*any* path including its own `robots.txt`. So "only fetch links a verified artist already gave
us" doesn't route around anything here — the site doesn't answer non-browser requests at all
right now, regardless of scope.

**What got built instead, from Brandon's own framing** (*"even if there is a high failure rate,
it's better than nothing as long as it's not majorly intensive or costly"*): rather than one
more single-platform integration, a more general pass over a claimed artist's own verified
links.

- **Faircamp** (self-hosted, no central API) got a real dedicated parser, verified against
  Brandon's own live instance rather than guessed. The homepage doubles as the release list —
  every release is a bare relative link off it — but there is no reliable date or price
  anywhere in Faircamp's own markup (checked: no JSON-LD, no `<time>` tag, no `pubDate` in its
  own RSS feed). So it only ever produces identity and artwork, honestly.
- **Discovered links**: an artist's other pages (their Faircamp archive, their official
  website) sometimes link directly to a *specific release* on a platform we can't fetch
  ourselves — confirmed on Brandon's own site, which links straight to
  `subvert.fm/kid-lightbulbs/infinite-normal`. `findDiscoveredReleaseLinks` reads these out of
  markup already fetched for another reason (never fetches Subvert itself), and only ever
  attaches on an **exact** title match against an existing release — never a fuzzy guess, since
  a wrong attachment would point a fan at the wrong record entirely.
- **Bandwagon deliberately excluded.** Its `robots.txt` sets `Crawl-delay: 1000` (seconds, with
  an explicit "misbehaving bots will be blocked" warning) — respecting that properly needs a
  persistent, cross-invocation rate tracker, which wasn't worth building for one platform in
  this pass.
- **A live test of the actual `/albums` listing page for Brandon's own Bandwagon profile
  returned nothing** (likely client-rendered) — a second, independent reason it wasn't worth
  building for right now even setting the crawl-delay aside.

**Looking ahead, per Brandon:** *"this just reiterates the importance of artist curation — if
we can't rely on scraping without a bunch of business development chats, artists need to be
able to do this themselves."* Step 9 (curation) landing the same day as this finding wasn't a
coincidence of scheduling — it's the backstop every source in this section depends on, and it's
also the natural next step Brandon named: a self-serve "catalog my own releases" button so an
artist can trigger this themselves rather than waiting on an admin.

### Steps 10, 5 and 6, built 2026-08-01 (evening) — branch `unstream-releases-phases-63b396`

Brandon: *"we still need to build 10, 5 and 6 ... Keep going until you cannot anymore such that
the feature is complete pending merge, and I can test it end to end."* All three are done.
Build, typecheck, 631 API tests, 528 web unit tests and 21 Mac XCTests all pass. Nothing merged
or deployed.

#### Step 10 closed: Jam.coop

**Mirlo was re-checked live, not assumed.** `api.mirlo.space/robots.txt` still carries
`Disallow: /v1/` under its `# Disallow crawling the API` comment, so Mirlo stays paused pending
Brandon's conversation with their team. Subvert still answers HTTP 429 to everything.

**Jam.coop was built instead, and it should probably have been first.** Its `robots.txt` contains
a single comment and **no `Disallow` at all**; it is entirely server-rendered; and one album-page
fetch returns title, artwork, date, price, currency and format together — so a release costs
*one* request, against Faircamp's two (and Faircamp never has a date) or Bandcamp's grid-plus-
detail. The "too small for round one" call in §10 weighed coverage only and missed that it is by
far the cheapest source to ingest correctly. 231 artists in its directory, which
`search-sources.ts` already scrapes in one cached request.

Sampled ~16 albums across the platform: every one is `£X.XX or more. Digital download. MP3 and
FLAC` — uniformly GBP, uniformly name-your-price-with-a-floor, uniformly digital. The floor is
published as the price (what a fan can actually pay), the same call the Faircamp purchase parser
makes. Only `£ € $` are mapped; any other symbol yields **no offer at all** rather than a price
in a guessed currency, because `formatMoney` defaults a null currency to USD and would render
"¥800" as "$800".

One honest limitation recorded in the code: the Jam.coop pass has **no 30-day `detail_checked_at`
skip**, because the album page *is* how a release is identified — there is nothing to skip to.
Every run re-reads every album page. Affordable only here: catalogues are tiny, the cooldown is
7 days, and the per-artist cap is 20.

#### Step 5: alerts now come from the catalog

`check-releases` tries the catalog first and falls back to the live scrape only when an artist
has **never been catalogued**. That distinction is the whole design: `null` means "we have not
looked", `[]` means "we looked and there is nothing". Collapsing them would either switch alerts
off for every artist nobody has saved yet, or re-scrape Bandcamp for everyone forever.

The response stays backwards-compatible with the shipped Mac app (3.3.x) and extension (2.5.x):
`release` (singular) is still populated, and `releases[]`, `source`, `platforms`, `status`,
`offerSummary`, `platformUrl` are additive. Verified both clients decode `platform` as a plain
string and ignore unknown keys.

**Disposition of every §5 defect — this is the part to argue with:**

| # | Defect | Status |
|---|---|---|
| 1 | Second release from one artist lost permanently (Mac) | ✅ **Fixed.** The outer artist-name dedup in `checkAllArtists` is gone; `selectUnseen` is now the single dedup point. Extracted as a pure function so the bug is directly testable, with a regression test that replays the two-check scenario. |
| 2 | Upcoming releases impossible to alert on | ✅ **Fixed.** `daysDiff >= 0` removed. Live data confirms this matters: the catalogue currently holds **2 future-dated releases** that could never have fired an alert. |
| 3 | Only the latest release per platform is seen | ✅ **Fixed** on the catalog path — all releases in the window are returned. |
| 4 | Multi-platform releases collapsed by hardcoded priority | ✅ **Fixed** on the catalog path — every platform is reported, ordered artist-paying-first via `orderedSourcePlatforms`. **The hardcoded `mirlo > faircamp > bandcamp` list is deliberately left in the live-scrape path**: it only runs for uncatalogued artists, has one result per platform and no offer data to rank by, so changing the order would move the arbitrariness rather than remove it. |
| 5 | A closed laptop loses releases permanently | 🟡 **Partial.** The server now accepts `sinceDays` (default 31, capped 365) so a client can ask for the window since its last check. **Shipped clients don't send it**, so this needs a client release to actually help. The default was deliberately *not* widened: doing so would fire a burst of notifications about month-old records for every existing user. |
| 6 | Alert state doesn't sync across devices | ❌ **Not built, deliberately.** Needs a new synced table with RLS plus changes to both clients — larger than the other six combined, and untestable end-to-end without shipping app builds. Flagged rather than silently skipped. **Decide separately.** |
| 7 | Notification body is thin | ✅ **Fixed.** Body now reads *"Infinite Normal" — out now on Bandcamp and Mirlo · from $8 · ≈$6.80 to artist*, built up from what the server actually knew — an unknown price omits the clause rather than printing a placeholder. Upcoming releases read "announced for 1 September". |

Client-side, `ReleaseCheckAPI.checkReleases` now returns `[ReleaseCheckResult]`; `NewRelease`
gained `platforms`/`status`/`offerSummary` with a custom `init(from:)` supplying defaults, so
alerts persisted by an older build still decode instead of a fan's stored list being discarded on
upgrade.

#### Step 6: per-fan feeds

Five routes on one Netlify function: `/feed/f/{token}.ics|.xml` (private, primary),
`/u/{handle}/releases.ics|.xml` (public, gated on the existing `saved_artists_public` opt-in),
`/a/{artist}/releases.ics|.xml` (public). Token management at `/api/me/feed-token`
(GET creates lazily, POST rotates, DELETE revokes) with UI in `/settings`.

**The token is stored in plaintext, unlike `api_keys` which are hashed.** A hashed token could
never be shown to its owner again, and a calendar URL has to be re-readable on a new device —
`api_keys` can be hashed precisely because they are shown once and replaced when lost. It is
treated as a credential everywhere else: owner-only RLS, never logged, `private, no-store`,
`noindex`, and a bad token returns **404 rather than 401** so it can't be probed.

**Deliberate deviation from §3, worth overruling if you disagree.** §3 says the feed carries
*upcoming releases only* ("a calendar of past releases is a changelog"). It is implemented as
**upcoming plus a 30-day trailing window**. The catalogue was measured first: 621 releases, 613
dated, but only **2 future-dated** and **9** within thirty-days-plus-future. Upcoming-only would
leave nearly every fan's calendar empty, and a record that came out last week is still something
they may not have bought — the same purchase-intent moment the alerts serve. One constant
(`FEED_TRAILING_DAYS`) if you want it reverted.

Two routing traps, recorded because they cost real time: `/a/{artist}/releases.xml` matches the
two-segment `release-page` edge pattern and `/u/{handle}/releases.ics` matches `/u/*`, and **edge
functions run before redirects** — so both need `excludedPattern`. And `event.path` is not
dependable behind a `status = 200` rewrite; `rawUrl` is.

#### Two pre-existing problems noticed in passing, not fixed

- **`npm run migrate:dry-run` and `migrate:list` are broken.** They pass `--project-ref`, which
  the Supabase CLI (2.111.0) no longer accepts on `db push` / `migration list`.
- **A junk row is in the catalogue:** *"NanoPolix Nano Car Cloth: Automotive Paint Maintenance and
  Surface Care"*, dated 2026-07-15. Almost certainly a bad Discogs artist match — worth tracing
  what matched it, since it suggests a whole class of bad matches.

### What a fan can see today

An artist page lists that artist's releases below **Follow** — artwork, title, type, date, and
the cheapest way to own it (*"Album · 1 June 2024 · from $7"*, or *"Name your price"*). Each row
links to `/a/{artist}/{release}`, a buying guide showing every format with its price, its
availability, and an estimate of what reaches the artist.

Still invisible: alerts (step 5) and feeds (step 6). Coverage is also thin by design — a release
only exists once someone has saved or searched that artist, or an admin has pressed the button.

### The grid-only gap, closed (#360)

Dates, formats, prices and pre-order state live only on individual Bandcamp release pages, read
from the JSON-LD graph the site publishes for machines (not the private `data-tralbum` blob).
Verified live: *digital $10 / vinyl $25 / CD $12, and a $35 vinyl correctly marked sold out.*

The pass is **metered, never swept**: newest-first, 20 pages per artist, 100 per invocation,
~1 req/sec, a 9-minute deadline inside the 15-minute background function, and a 30-day refresh
because prices change and vinyl sells out. `release_sources.detail_checked_at` records what has
been read so a bounded run resumes rather than re-reading the same newest few forever;
`release_catalog_state.releases_detailed` sits beside `releases_found` because the two fail
independently — a grid can parse perfectly while every release page is challenged.

Two variants of one format (a standard LP and a £60 deluxe box) collapse to the **cheapest
available**, since `release_offers` is unique on `(source, format)` and quoting the box as "the
price of the vinyl" would be a wrong number in front of someone deciding whether to buy.

**Name-your-price is `price: 0` on Bandcamp**, which rendered as "$0" — telling a fan a record is
free when they are being invited to decide what to pay. Caught on Kid Lightbulbs' own catalogue,
where every release is name-your-price, so every row on every page would have read "$0".

### The release page (#362)

`/a/{artist}/{release}`, pure SSR, `noindex, follow`, no JSON-LD, route declared before `/a/*`.
Payouts render as ranges (`≈$20–$21.25 to artist`), never point estimates; Bandcamp Friday is
honoured. Sources order by payout so artist-paying options always lead.

### ⚠️ The artist page has two renderers now — build on the React one

**PR #369, unrelated to Releases, changed the ground under this feature.** `/a/:slug` used to
serve hand-written static HTML to everyone; it now serves that **only to crawlers**, and real
browsers get the React SPA. The releases section from #366 had gone into the edge function, so
for a day *Googlebot could see an artist's discography with prices and no human could*. The
admin button was first built the same way.

Both were rebuilt in React in #370. The rule for anything new on the artist page:

> `api/edge/artist-page-static.ts` is **crawler markup**. Features go in
> `apps/web/src/pages/ArtistPage.tsx` and its components, fed by `api/functions/artist-page.ts`.

The formatting helpers (`cheapestOfferSummary`, `formatReleaseDate`) live in
`api/shared/release-display.ts` and are imported by **both** renderers, so the two cannot drift
on what a price or a partial date looks like. That is the first import from `api/shared` into
the web app; the older convention (`sources.ts` mirroring the platform registry by hand) is a
worse fit for code that makes claims about money.

### ⚠️ Cataloging never ran at all until 2026-08-01

Two independent misconfigurations produced the same symptom — an empty `releases` table — and
fixing either alone would have changed nothing:

1. **`INTERNAL_FUNCTION_SECRET` was never set** in Netlify. This doc previously asserted it was.
   `requestArtistCatalog` logged a line and returned; the background function refused everything.
2. **All three gates tested `CONTEXT === 'production'`, and `CONTEXT` does not exist at Netlify
   function runtime.** Only `URL`, `SITE_NAME` and `SITE_ID` reach a serverless function;
   `CONTEXT` and `DEPLOY_PRIME_URL` are build-time variables. So every gate refused, always, in
   production. Fixed in #372 with `RELEASE_CATALOG_ENABLED`.

**Why it stayed hidden for days:** refusing looked exactly like working. Two of the three gates
only `console.log`ged, and an empty catalogue is indistinguishable from a quiet week — "no
traffic yet" was a plausible story that went unchallenged twice. The unit tests passed
throughout because they set `CONTEXT` themselves, asserting a rule the runtime could never
satisfy.

**What surfaced it:** the admin button, which reports its own refusal to a human — *"this deploy
is unset"*. Brandon: *"this is why i wanted to build the button thing."* The general lesson is
that a silent gate is a bug waiting to be invisible, and the fix is a surface that says no out
loud.

Side effect of (1) worth noting: the v1 public API was **double rate-limiting**, because the
wrappers forwarded an empty `x-internal-skip-ratelimit`. No security hole — both bypass checks
read `if (!secret || header !== secret)` and so fail closed.

### Live behaviour as of now

- Cataloging triggers on **save**, on **search** (a resolved artist with a Bandcamp link), and
  on the **admin button** on any artist page.
- Guards: 7-day cooldown, hourly cap of 60 searched / 240 saved, per-artist exponential backoff.
  The admin button and the CLI clear the cooldown, because a deliberate "catalog now" that
  silently does nothing for a week is worse than no button.
- **Enabled by `RELEASE_CATALOG_ENABLED=true`**, a custom Netlify variable scoped to **Functions**
  and set for the **Production context only**. Unset means off, as does any value other than
  exactly `true`. Deploy previews therefore stay off — they run against the *production*
  Supabase, so an ungated one would write real releases and spend the real crawl budget.
  Note: a variable declared in `netlify.toml` cannot carry scopes and defaults to Builds +
  Post processing, so it must be set in the UI or via `netlify env:set`.
- Also required: `INTERNAL_FUNCTION_SECRET` (Netlify **and** local `.env` for the CLI) and
  `ADMIN_EMAIL` (or the admin button never appears for anyone).
- Observability: `release_catalog_state` — `last_attempted_at`, `last_catalogued_at`,
  `releases_found`, `releases_detailed`, `last_error`, `consecutive_failures`. A run finding 0
  where it previously found 20 means a parser break or a bot challenge, not an artist deleting
  their catalog. `releases_found` high with `releases_detailed` at 0 means the grid parsed but
  every release page was refused.
- Local tools, neither of which writes to any database:
  - `npm run ingest:try -- <artist> --detail=3` — real fetch, parse and mapping; prints what
    would be written.
  - `npm run preview:release -- <artist>` — serves the real release page on `:8788` from real
    Bandcamp data, since `npm run dev` cannot render an edge function at all.
  - `npm run catalog:artist -- <slug> [--force]` — triggers the real production crawl and polls
    for the outcome.

### Carried over, not part of this feature

- Mac app drops a second release from an artist who already has an unread alert (client bug).
- `artist_links` accepts any http(s) URL from a claimed artist — only a protocol check.

---

## In plain terms

**Today Unstream answers:** *"I'm listening to this artist — where can I support them?"*

**Releases adds:** *"This specific album is out — where do I buy it, and how much reaches the
artist?"*

Three things, all for fans:

**1. A page for each album — a buying guide, not a link list.**

> *Vinyl — $30 — Bandcamp — ≈$25 to the artist*
> *Digital — $8 — Mirlo — ≈$7 to the artist*
> *Cassette — sold out*

Nobody has this page. Odesli, the distributor pages, and feature.fm all answer "where can I
*stream* this," which is the opposite of what Unstream is for.

**2. One calendar covering all the artists you've saved.**

You've saved 40 artists. You subscribe **once**, in Apple or Google Calendar, and see everything
they have coming. Not 40 separate subscriptions. This works because Mirlo publishes release dates
*in advance* — so the calendar shows the future, which is the only version worth subscribing to.

**3. Release alerts that actually help you buy.**

Today an alert says *"X is out now on Bandcamp"* and sends you to Bandcamp. It should say
*"X is out — vinyl and digital"* and send you to the page in #1. Right now the alert silently
picks one platform and hides the others — so at the exact moment someone wants to buy, we hide
the payout comparison that is the entire point of the product.

### Why it's worth building

Two honest reasons, neither of them speculative:

- **Something is already broken.** The alerts do the hard part — noticing that an artist you
  follow released something — and then hand you off to one platform, chosen arbitrarily. That's a
  defect in a shipped feature, not a missing nice-to-have.
- **It removes a lot of wasted work.** Today every user's app checks every artist individually,
  every week. 100 users following 30 artists each = ~3,000 scrapes of Bandcamp per week for
  identical information. If Unstream builds the list once on the server, everyone just reads it.
  Better for Bandcamp, faster for users, and it closes a security hole in today's setup.

### The one genuinely hard part

Knowing that *Carrie & Lowell* on Bandcamp and *Carrie & Lowell* on Mirlo are **the same album**,
so the fan gets one page instead of two.

My recommendation: **don't try to solve this perfectly.** Combine two entries only when we're
certain — matching IDs, or identical titles of the same type. When unsure, leave them separate.

- Two pages for one album looks slightly dumb, but it's obvious and easy to fix.
- One page that wrongly merges two *different* albums is wrong information, and nobody will ever
  notice it.

So we deliberately err toward leaving things apart. That's what "under-merge, never over-merge"
means everywhere below.

### Pages are built on demand — never in bulk

**Decided 2026-07-31.** We do not pre-generate a catalog. Cataloging is **triggered by a fan
saving an artist.** Brandon: *"Ideally, the pages are generated solely based on demand — that is,
a fan searches and saves an artist → that triggers Unstream starting to catalog that artist's
releases."*

This is the most important architectural decision in the feature, and it fixes three problems at
once:

- **The crawl cost mostly disappears.** We only ever fetch catalogs for artists a real person
  cares about — not 790 artists speculatively.
- **The SEO risk becomes structurally impossible.** You cannot accidentally mint 16,000 pages
  when page count is bounded by saved-artist count.
- **Cost scales with engagement, not catalog size** — the healthiest possible shape for this.

Two mechanics that follow:

1. **Saving must not block on cataloging.** The save returns instantly; cataloging is queued.
   Release data appears shortly after, so the UI needs an honest "still gathering" state rather
   than an empty section that looks broken.
2. **Two modes, not one.** *Deep catalog* once when an artist is first saved (their whole
   discography), then *shallow check* on a schedule for new releases (which is the alerts
   feature). Don't re-crawl full discographies repeatedly.

### Bandcamp first, then Mirlo — reversing my earlier advice

I originally recommended Mirlo first on cost grounds. **That was wrong, for two reasons.**

**The cost objection evaporates under demand-driven cataloging.** My 16,000-request figure assumed
a bulk backfill of all 790 artists. Cataloging only saved artists collapses that to a trickle,
spread over time as saves happen. The main argument for Mirlo-first was a problem the decision
above already solved.

**And the surface-area gap is enormous.** Measured across all 791 pre-generated artist files:

| Platform | Artists present | With release data |
|---|---|---|
| **Bandcamp** | **791 (100%)** | **791** |
| Discogs | 642 (81%) | 0 |
| Qobuz | 386 (49%) | 247 |
| **Mirlo** | **0** | **0** |

Mirlo appears on **none** of them. So a Mirlo-first launch would have shipped a feature visible
for approximately zero of the current catalog. Brandon's call is correct on the merits, not just
as a preference.

Two honest caveats on that table: this dataset was *built from* Bandcamp, so 100% is partly a
selection artifact rather than a pure coverage claim; and `buymeacoffee`/`ampwall`/`kofi` also read
100% because they're search-link templates, not real verified links. Neither changes the
conclusion — Mirlo at literal zero across 791 artists is the decisive number.

So: **Bandcamp first, Mirlo second, then look wider** (§10).

---

## The decision

Three pillars, one audience:

1. **Release pages built around formats, prices, and payout** — "where can I buy this, in what format, and how much reaches the artist."
2. **Per-fan feeds**, not per-artist — one calendar/feed of everything your saved artists have coming.
3. **Fix the release-alerts UX** — route alerts to release pages and repair what's broken underneath.

**Explicitly not V1:**

- **Artist-facing authoring.** Release pages are something an artist *gets* by claiming their profile and may optionally use. No pre-release/announce-day authoring flow. No artist monetization — Brandon: *"There is no plan to monetize Unstream on the artist side."*
- **SEO as a driver.** Treated as a byproduct. (Flagging this as my read of the pivot — you listed three pillars and SEO wasn't one. It changes a real decision; see §2.)

### Why this is a much better V1 than the spec's

All three pillars serve **one user: a signed-in fan who has already saved artists.** That single audience does a lot of work:

- It removes the hardest unsolved problem in the whole concept — the announce-day inversion (`design-review` §1.6). Distributor and feature.fm pages are pre-release tools; our pipeline is discovery-based, so the artist pitch needed authoring we now don't have to build.
- It removes the SEO risk entirely (§2).
- It means the release page is a **destination for an alert**, not a landing page for a stranger. Its quality bar becomes *"does this help a fan decide where to buy"* — a far easier and more honest target than *"does this rank."*

Net: this is an **app feature with a web destination**, not a content play. Much smaller, much lower risk, and the part that's genuinely novel is the part we keep.

---

## 1. What the pivot changes from the design review

| Design review said | Now |
|---|---|
| §1.4 SEO is real but risks the domain via ~16k thin pages | **Risk gone.** `noindex` by default costs nothing if SEO isn't the driver. Indexation becomes a deliberate later experiment on pages that are already good. No quality-bar trade-off to agonise over. |
| §1.6 artist pitch needs an authoring flow | **Dropped from V1.** Step 9 leaves the critical path. |
| §3 "the artist is the reviewer" is the dedup backstop | **Weakened — see §4.** If claiming is optional and unmonetized, most artists won't curate. The under-merge bias and an admin queue have to carry it instead. |
| §1.5 per-fan feed at `/u/{handle}/releases.ics` | **Corrected — see §3.** That conflates public list-sharing with private subscription. Needs a token URL. |
| Step 5 (alert routing) was a small step after pages | **Now a pillar**, and it's more than routing — there are real bugs underneath (§5). |

## 2. Indexation, resolved cheaply

Because SEO isn't the driver:

- Release pages ship **`noindex` by default.**
- Revisit indexation later, deliberately, for pages that already clear a quality bar (≥2 sources, or real offer data, or claimed).
- No 16,000-page rollout, no scaled-content-abuse exposure, no risk to the artist-page and guide rankings already earned.

If you *do* want the SEO upside eventually, this ordering still gets it — it just earns it instead of front-running it. Correct me if SEO is meant to stay a first-class goal, because that's the one thing here that would change the plan.

## 3. Per-fan feeds — the design correction

I previously proposed `/u/{handle}/releases.ics`. That's wrong as the primary: it requires a claimed username *and* opting into public sharing, and most fans won't want their subscription list public.

**Calendar clients cannot authenticate.** Apple Calendar and Google Calendar fetch a URL on a schedule — no OAuth, no bearer token, no cookies. So the only workable private feed is an **unguessable, revocable token URL**:

| Route | Audience | Notes |
|---|---|---|
| `/feed/f/{token}.ics` | **Private, primary.** The fan's own subscription | Opaque high-entropy token, one per user, revocable/rotatable from `/settings`. Treat as a credential: `noindex`, `Cache-Control: private`, never logged. |
| `/feed/f/{token}.xml` | Private Atom, same token | For RSS readers. |
| `/u/{handle}/releases.ics` | **Public, secondary** | Only for users already opted into public sharing (`usernames.saved_artists_public`). A nice "what I'm looking forward to" share, not the product. |
| `/a/{artist}/releases.xml` | Public per-artist | Cheap once the catalog exists. Serves the optional artist use and journalists. |

Content: one VEVENT per upcoming release across all saved artists, all-day on the release date, summary `{Artist} — {Title}`, description linking the Unstream release page. **Upcoming is the point** — a calendar of past releases is a changelog; a calendar of what's coming is a reason to subscribe. Mirlo's forward dates and `isPreorder` make this real on day one.

Security notes: token in the path is unavoidable for calendar clients, so make it long, single-purpose (read-only, this feed only), rotatable, and don't reflect it in analytics or Sentry.

## 4. Dedup, with the artist backstop removed

The design review leaned on claimed artists correcting their own discographies. With claiming optional and unmonetized, that won't happen at volume. So:

- **Tiers 1–2 auto-merge** (hard identifiers: `external_id` per source, MB release-group id; then exact normalized title *within* release type via `normalizeForComparison`).
- **Tier 3 never auto-merges** — it queues.
- **"Under-merge, never over-merge" is now load-bearing**, not a preference. A duplicate release page is visible and self-correcting; a wrong merge asserts two different albums are one and nobody will catch it.
- **The backstop is an admin queue**, i.e. you. Keep it small by construction: only surface candidate pairs above a confidence floor, and accept leftover duplicates as the cheaper failure.
- Artist editing stays available for claimed profiles — just don't plan around it.

One relief: because release pages are `noindex` and primarily reached from an alert about an artist the fan already follows, a surviving duplicate is a cosmetic annoyance rather than a public false claim. The stakes of imperfect dedup drop a lot under this scoping.

## 5. Release alerts — the actual defects

"Improve the UX" undersells it; I read the implementations and there are correctness bugs. Grounded list, worst first:

1. **Second releases from the same artist are permanently lost (Mac).** [`ReleaseAlertManager.swift:229`](apps/mac/Unstream/ReleaseAlertManager.swift:229) dedups by **artist name** against the display list — but [line 257](apps/mac/Unstream/ReleaseAlertManager.swift:257) already dedups correctly by release name and **marks the release known at line 262 before the outer check runs**. So if an artist has an unread entry in the list, their genuinely-new second release is dropped from the list *and* the notification, while already being recorded as known — it can never be re-detected. Two layered dedup rules, and the outer one is wrong. The extension does this correctly, so it's Mac-only.
2. **Upcoming releases are structurally impossible to alert on.** `isWithinLastMonth` requires `daysDiff >= 0` ([check-releases.ts:78](api/functions/check-releases.ts:78)), so a future-dated release is *filtered out*. Mirlo's forward dates are actively discarded today. The most delightful possible alert — "your artist just announced an album for September" — cannot fire.
3. **Only the latest release per platform is ever seen.** `checkAllPlatforms` returns a single `ReleaseResult`. Two releases in one window → one detected.
4. **Multi-platform releases are collapsed to one platform by hardcoded priority** (`mirlo > faircamp > bandcamp`, [check-releases.ts:299](api/functions/check-releases.ts:299)). If an album is on Bandcamp *and* Mirlo, the fan is never told, and the payout comparison — the product's entire thesis — is invisible at the moment of highest purchase intent.
5. **A closed laptop loses releases permanently.** Weekly Friday check + a hard 31-day window means anything that ages out while the machine is asleep is never detected.
6. **Alert state doesn't sync across devices.** Two independent stores (`UserDefaults` on Mac, `chrome.storage.local` in the extension). Saved artists sync; alert state doesn't. So the same release is unread twice, and dismissing it in one place doesn't clear the other.
7. **The notification body is thin.** `"X" is out now on Bandcamp!` — one platform, no formats, no price. With offers data: *"out now — vinyl + digital, from $8"*.

Items 2, 3, 4, and 6 are all fixed *by the catalog existing*, not by client patches — which is the strongest argument that the catalog is the right investment. Item 1 is a client bug worth fixing on its own regardless.

## 6. Data model

```
releases
  id, artist_id → artists(id)
  title                 -- display quality, not normalized
  slug                  -- unique per artist; sha1 or UUID on collision, never a hex prefix
  release_type          -- source-native: album | ep | single | compilation | live | remix
  release_date          -- sanity-bounded (reject outside 1900 … today+3y)
  date_precision        -- day | month | year | unknown   (MB gives partial dates)
  status                -- announced | released           (derived: date vs today, isPreorder)
  artwork_url
  musicbrainz_release_group_id
  is_hidden, needs_review
  unique(artist_id, slug)
  unique(artist_id, musicbrainz_release_group_id) where not null
  index (artist_id, release_date desc nulls last, created_at desc)

release_sources
  id, release_id → releases(id)
  platform              -- platform-registry id; category derived, no is_streaming boolean
  url
  external_id           -- bandcamp "album-1891263657", mirlo trackGroup id  ← identity anchor
  first_seen_at, last_seen_at
  unique(platform, external_id) where external_id not null
  unique(release_id, platform)

release_offers          -- the differentiator
  id, release_source_id → release_sources(id)
  format                -- digital | vinyl | cassette | cd | other
  price, currency
  availability          -- available | preorder | sold_out | unknown
  captured_at
```

Three things the spec's model lacked, each earning its place:

- **`external_id` with a global unique constraint** makes ingest idempotent without depending on titles or slugs. Re-crawls update rather than duplicate even when a title changes. Bandcamp hands this to us free in the grid (`data-item-id`), Mirlo has `id`.
- **`date_precision`** because MusicBrainz returns year-only dates, and rendering "January 1" for one is a fabrication that also poisons ±N-day dedup.
- **`release_offers`** because it's the whole product thesis, and retrofitting it after pages ship costs more than including it now.

### The number that makes this worth building

Payout % lives in `api/shared/platform-registry.ts`; Mirlo additionally returns a per-release `platformPercent`. Combined with price:

> **Vinyl · $30 · Bandcamp · ~$25.50 reaches the artist**

Nobody shows this. It's the emotional payload of the whole product, at the exact moment someone is deciding where to buy.

**Label it as an estimate.** Bandcamp's real take varies (digital vs physical rates, payment processing, and 100% on Bandcamp Fridays — which the codebase already models). Asserting false precision about someone's income would be worse than rounding honestly. "≈" and a tooltip explaining the basis.

## 7. Build order

*The original plan, kept for its reasoning. For what actually shipped and in what order, see
"Current state" at the top — steps 0–4 are done, and two things landed that aren't in this
table: the `catalog:artist` CLI and the admin catalog button.*

| # | Step | Why here |
|---|---|---|
| **0** | **`check-releases` hardening — ship now, independently** | Still open on `main`. Needs **per-hop** hostname validation (an input-URL allowlist is redirect-bypassable — Bandcamp Pro custom domains prove the path is live), a stored-URL check rather than an allowlist for self-hosted Faircamp, and batch-or-429-aware clients. Not blocked by any of this. |
| **1** | Schema (§6) + `release-utils.ts` **with tests** | Pure logic, no network. The three worst PR #336 bugs were in ~15 lines of untested normalization. |
| **2** | **Demand-driven ingest queue** | Saving an artist enqueues a catalog job. Save returns instantly; cataloging runs off the request path — never inside `persistSearchResults`, which is awaited during search and would add ~0.6–1.6s to every query. Deep-catalog once, shallow-check on a schedule. |
| **3** | **Bandcamp catalog ingest** | Grid first (cheap, HTML the probe already caches) for stable id, artwork, title, album-vs-track type. Album detail per release for date, formats, prices, pre-order — rate-limited and only for saved artists. Follow custom-domain redirects and store the canonical URL. Merge fields, never blind-overwrite good data with nulls from a partial fetch. |
| **4** | Release page — pure SSR, `noindex`, offers UI | Route declared before `/a/*` via a `pattern` regex, since Netlify path globs can't express "exactly two segments". Pure SSR only (UNS-100 bifurcation class). ✅ shipped as specified — note this is *unlike* the artist page, which since #369 is SSR for crawlers only. |
| **5** | **Alert rewiring + Mac bug fix** | Alerts point at release pages; fix defect 1; surface multi-platform and upcoming. Pillar 3. |
| **6** | **Per-fan feeds** (§3) — token ICS + Atom | Pillar 2. |
| **7** | **Discogs + MusicBrainz enrichment** | Discogs for physical formats, editions, real selling prices, and `master` IDs — filter to `role: Main` + `type: master`, since one artist returned 3,241 raw entries. MusicBrainz for release groups, MBIDs, partial dates (already wired). **No iTunes.** |
| **8** | Dedup tiers 1–2 automated, tier 3 queued | Only matters once a second source exists — so it lands with step 7, not before. Discogs `master` IDs do part of the work for us. |
| **9** | **Artist curation UI** (§11) | Deferred by decision, but its **schema lands in step 1** — see below. |
| **10** | **Mirlo**, then revisit Subvert / Jam.coop | Mirlo is one request per artist and the richest payload of any source, but on 0 of 791 artists — a quality addition, not a coverage one. Respect `isPublic`/`hideFromSearch`; filter empty-title drafts; sanity-bound dates. |

Steps 1–6 are the vertical slice, **Bandcamp-only**, and they deliver all three pillars to the
widest possible audience. A useful property of this ordering: with one source there is **no dedup
problem at all** — the hardest part of the feature is deferred until step 8, by which point the
product has already proven itself.

## 8. Risks that survive the pivot

- **Mirlo-only launch is visibly patchy.** The Releases section appears for a minority of artists. Acceptable as a beta; needs a deliberate empty state rather than a missing section.
- **Offer data goes stale.** Prices change and vinyl sells out. A page promising "$30 vinyl" that's sold out is worse than no page. Show `captured_at`, and treat availability as a claim with an age, not a fact.
- **Artwork at scale.** Hotlinking `bcbits.com` for thousands of releases is fragile and impolite; rehosting raises rights questions. og:image needs a stable URL regardless. Existing artist images set precedent but releases multiply it ~20×.
- **Bandcamp crawl budget** (step 6). `/music` is robots-permitted, but per-album fetching at catalog scale is a different posture than one probe per artist.
- **Series-heavy artists break the chronology UI.** One live Mirlo artist has 33 releases including *Inaction I–V* and *Outside Vol. 1–4*. "Newest first" is not a design.
- **Feed token leakage.** Path tokens end up in logs and referrers by default. Audit analytics and Sentry scrubbing before shipping step 5.

## 10. Sources beyond Bandcamp and Mirlo

Brandon asked what else exists. Split by what a source can actually *do* — because "tells us a
release exists" and "lets a fan buy it" are different jobs.

### iTunes — a good idea, with one real problem

Brandon's argument: the **iTunes Store is a purchase, not a stream** — you buy a download you own
— so it's a legitimate fallback for "you can't get this direct, but you can at least buy it."
That's a fair correction to my earlier "iTunes may enrich but never discover" rule, which
conflated the iTunes Store with Apple Music streaming.

**What I verified works.** `itunes.apple.com/search` is free, needs no token, and returns real
purchase data — for one album: `collectionPrice: 9.99`, `currency: USD`, `collectionType: Album`,
`trackCount: 16`, `releaseDate`. A returned price means the album is genuinely purchasable, and it
slots straight into the offers model as a digital format with a price.

**What doesn't work cleanly — the problem.** The URL it hands back (`collectionViewUrl`) points to
**`music.apple.com`** — the Apple Music streaming page — not a buy page. So we'd know a purchase
price exists but link somewhere that mainly invites a stream. That's the exact failure mode worth
avoiding: sending a fan to a streaming page on a product built to route away from streaming.
Needs investigating before we rely on it: can a reliable purchase URL be constructed, and is
Apple still actively selling downloads at all? Apple has spent years de-emphasising the iTunes
Store, and a "buy" fallback that quietly turns into a streaming link is worse than no fallback.

**A second problem, and it's a credibility one.** `payoutPercent` in the registry is a string range
('80-85%', '~70%'). Apple pays ~70% **to the rights holder** — which for most indie artists is
their distributor, who then takes their own cut or fee. On Bandcamp and Mirlo the *artist is the
seller*. So "~70%" is not comparable to Bandcamp's "80-85%" and would overstate what reaches an
indie musician while ranking iTunes above Beatport. If iTunes joins the registry it needs a
distinct presentation — a footnote about the distributor layer, not a number in the same column.

Useful side effect of the string ranges: they make point estimates impossible by construction, so
the honest output is *"$30 vinyl → roughly $24–25.50 to the artist"* rather than false precision.

### Discogs — I was wrong to dismiss it (revised 2026-07-31)

Brandon pushed back on my "no artist payout, enrich only" call. He was right, and I checked.

**What I verified.** `api.discogs.com` needs **no token** for the database endpoints (200 with just
a User-Agent), and returns exactly the data this feature is built around:

- `GET /releases/{id}` → `formats: ['CD']`, `year`, `released`, `tracklist`, `images`, `labels`,
  and **live marketplace data: `num_for_sale: 32`, `lowest_price: 2.64`.**
- `GET /artists/{id}/releases` → a full discography, paginated, each entry with `title`, `year`,
  `format`, `role`, `type`, `label`, `stats`.
- **Digital is catalogued.** Formats came back as `File, MP3, 320` and `File, FLAC, Single` — so
  Brandon's instinct that Discogs covers digital was correct; it isn't physical-only as a database.
- `extractDiscogsArtistId` already exists in `api/search/enrichment.ts:220`, and 642 of 791 artists
  (81%) already have a Discogs link. The artist ID is effectively already in hand.

**Two genuinely valuable things Discogs gives us that nothing else does:**

1. **Physical formats, editions, and real selling prices** — the heart of the "what formats exist,
   what does it cost" pillar. Bandcamp tells us what the artist sells today; Discogs tells us what
   exists in the world and what it actually trades for.
2. **`master` IDs solve a chunk of the dedup problem for free.** Discogs distinguishes
   `type: 'master'` (the abstract release) from `type: 'release'` (a specific pressing). They have
   already done the "these 40 pressings are one album" work. That's the identity layer I was
   worried about having to build.

**Three real costs, and they're not small:**

1. **Volume.** One well-catalogued artist returned **3,241 releases** — 33 requests even at 100 per
   page. Discogs indexes every pressing, region, and reissue separately. Must filter to
   `role: 'Main'` + `type: 'master'`, and even then it's the most expensive source per artist.
2. **Artist-level coverage ≠ release-level coverage.** Discogs is comprehensive for *catalogued*
   music (physical and notable digital) but a Bandcamp-only digital EP from a small artist likely
   isn't in it at all. So 81% of artists having a Discogs page does **not** mean 81% of the indie
   long tail's releases are there. Don't over-read that number.
3. **Rate limits** are 25/min unauthenticated, 60/min with a token — tight for catalog work.

**Payout is mixed, and unknowable from the API.** Secondhand pays the artist nothing; new stock
from a label pays through normal label accounting. `num_for_sale` / `lowest_price` aggregate across
all sellers and conditions, so we cannot tell which is which.

### The rule, revised

My earlier rule — *only direct-support sources may put a release in the catalog* — was too pure,
and Brandon's coverage argument beats it. Replacing it with:

> **List every purchase option. Order by payout. Label payout honestly.**

Why this is *more* Unstream, not less:

- **For out-of-print releases, secondhand is the only option that exists.** Telling a fan the
  truth — "no direct option; used vinyl from $12, the artist receives nothing from this" — is
  genuinely useful information that no other site surfaces. Hiding it doesn't help anyone.
- Unstream's edge is **honest comparison**, not a curated whitelist.
- There's precedent: the product already lists `hoopla` and `freegal` (libraries, tiny royalties).

**The guardrail that replaces the ban:** ordering and emphasis. Artist-paying options lead, always.
A page that surfaces "used CD $2.64" above "vinyl direct from the artist $30" would be off-mission
even if both facts are true. Search already sorts this way — reuse that logic.

### Sources: locked for round one (2026-07-31)

**Three sources: Bandcamp, Discogs, MusicBrainz.** iTunes is **dropped entirely for now** —
Brandon: *"These 3 might render iTunes unnecessary as a search source."* Agreed, and it's the right
call for a reason beyond redundancy: iTunes was the only candidate carrying two *unsolved* problems
(a purchase price attached to a streaming-page URL, and a payout number that isn't comparable to
direct platforms). Dropping it removes a credibility risk rather than just a source.

What we give up by dropping it: a digital purchase fallback for releases that aren't on Bandcamp or
Mirlo. So a Discogs-only release may show physical options — sometimes only secondhand — and no
digital. That's acceptable and honest, and it's covered by the revised rule above.

Two deferred, with reasons recorded so nobody re-litigates them:

- **Subvert** — *"will have usable APIs in the future, but not yet — I am bugging them about this."*
  Revisit when that lands; it's a co-op with genuinely good payout, so it's worth wanting.
- **Jam.coop** — too small for round one. Worth noting for later that we **already scrape their full
  artist directory** in one cached request (`search-sources.ts:880`, `https://jam.coop/artists`),
  which supports Brandon's instinct that *"it might be a small enough pool to scrape"* — a complete
  release-catalog scrape is likely tractable there in a way it never would be for Bandcamp.

### Coverage-ranked source list

Brandon: *"I think we need to stick to the major platforms if we want coverage."* Agreed, and the
honest ranking is uncomfortable — the platforms with reach are the big ones, and the platforms with
the best payout have almost none.

| Rank | Source | Role | Coverage |
|---|---|---|---|
| **1** | **Bandcamp** | Discover **and** purchase, direct | 100% of our artists. The workhorse. |
| **2** | **iTunes** | Catalog breadth + digital purchase price | Near-universal catalog; strongest exactly where Bandcamp is thin (bigger names) |
| **3** | **Discogs** | Physical formats, editions, real prices, **master IDs for dedup** | 81% of artists; weak on indie digital long tail |
| **4** | **MusicBrainz** | Release groups, MBIDs, partial dates | Already wired for enrichment |
| — | Mirlo, Jam.coop, Subvert | Purchase, best payout in the product | **Tiny.** Mirlo is on 0 of 791. Include when present; never depend on. |
| — | **Faircamp** | Purchase, direct | **Dropping from the priority list** — Brandon's right that breadth is too limited, and self-hosting means no central API |
| — | Ampwall | — | Dead end: 403s every non-browser client |
| — | Qobuz | — | robots-disallowed; links come from MusicBrainz, displayed but never fetched. Don't change this. |

So the coverage-first build is **Bandcamp → iTunes → Discogs**, with Mirlo and friends as bonuses
when an artist happens to be there.

**Still worth investigating concretely** rather than guessing: whether a reliable iTunes *purchase*
URL can be constructed, and whether Jam.coop or Subvert have usable APIs. Say the word.

## 11. Artist curation — deferred build, but the schema can't wait

**Noted 2026-07-31.** Brandon: *"I think verified, logged-in artists should be able to review,
curate, add new release links. This feels like a whole set of UI considerations and perhaps we build
it in later, but I want to note that now."*

Agreed on deferring the UI. **But one part of this must land in step 1**, because retrofitting it is
expensive and the failure mode is destroying an artist's work.

### The part that can't be deferred: ingest must never overwrite an artist's edits

Cataloging runs on a schedule and **re-crawls**. If an artist hides a wrong release, fixes a title,
or adds a link, the next crawl will happily overwrite all of it unless the schema knows which values
are human-authored.

There is already a convention for exactly this in the codebase — `artist_links.source` is
`'search' | 'musicbrainz' | 'claimed'` (`supabase/schema.sql:30`). Extend that to releases:

- **Per-row and per-field provenance.** Auto-ingested values are freely overwritable; anything
  marked artist-authored is **never** touched by ingest.
- **Merge, never replace.** Same rule as the `COALESCE` note in §6 — but higher stakes, because
  here the data being clobbered was typed by a person.
- **Never delete-then-write.** This project has already lost an artist's links exactly that way —
  all 13 of Kid Lightbulbs' links were wiped on 2026-07-29 by a delete-before-a-fallible-write on a
  deploy preview. That was your own profile. Release curation is the same shape of risk, so the
  transactional-write lesson from PR #350 applies from day one.

Getting the provenance columns into the step-1 migration costs almost nothing. Adding them after
ingest is already writing to the table means a migration plus a backfill plus reasoning about which
existing values were human-authored — which is unknowable after the fact.

### The three capabilities, in priority order

1. **Review / hide** — see what we auto-catalogued and suppress what's wrong. Highest value, lowest
   UI cost, and it's the correction mechanism for the ~4% wrong-artist rate the probe carries.
2. **Merge duplicates** — *"these two entries are the same release."* This is the **highest-value
   artist action in the whole feature**, because we deliberately under-merge (§4). Artists will see
   duplicates by design, and they're the only people who know for certain. It also drains the tier-3
   review queue that would otherwise land on you.
3. **Fix and add** — correct a title, date, or artwork; add a platform link we missed; add a release
   we never found.

### Two connections worth remembering

- **This partially restores the dedup backstop.** §4 notes that dropping the artist-side sell
  removed "the artist is the reviewer" as a reliable mechanism. This brings some of it back — but
  build it because it improves data quality, **not** as a dependency. Most artists still won't curate,
  so under-merge bias and the admin queue stay load-bearing.
- **It's the partial path to announce-day authoring.** Capability 3 ("add a release we never found")
  is most of what an artist would need to publish a page *before* release day — the artist-facing use
  case ruled out of V1 (§1.6). If that ever becomes interesting, this is the door to it. No need to
  decide now.

UI-wise it extends `ArtistEditPage.tsx`, which already handles bio, photo, links, location, and
dividers — so there's a established surface and permission model to hang it on rather than a new one.

## 9. Still open

1. **Is SEO genuinely a byproduct?** The one assumption above that would change the plan (§2).
2. **Real Mirlo↔Bandcamp overlap rate.** Every dedup rule depends on it and I'm guessing. One afternoon of measurement before step 7 — arguably before step 1.
3. **Does release identity measurably improve artist disambiguation?** `mergeByReleaseOverlap` already does a crude version. If yes, dedup pays for itself in search quality. If no, that's cheap early evidence not to go deeper.
4. ~~**Where does the Releases section sit on the artist page?**~~ **Answered 2026-08-01: below
   Follow.** Brandon: *"follow also hinges on the artist's preferred sort order of links"* — so
   Support directly and Follow together form one artist-ordered region, and releases are a
   different kind of thing that shouldn't interrupt it. Shown for **any** artist with a
   catalogue, not only verified ones: the releases derive from the Bandcamp link the page is
   already displaying as a place to buy, so listing what's behind it asserts nothing new, and
   gating on verification would hide the feature from nearly every artist. No releases → no
   heading at all, since an empty section reads as broken while its absence reads as "nothing
   yet".

5. **Should search results show releases?** Raised 2026-08-01 and deliberately deferred —
   search is the hot path (~1.8–3.0s) and a release query per result would add database reads
   for data absent for nearly every artist. Revisit once coverage is real. Brandon: *"i agree
   with you that we should hold on search results for now."*
