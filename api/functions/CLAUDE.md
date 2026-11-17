# api/functions/ — the live backend

Read this with the root `CLAUDE.md` (rules for every change) and `api/CLAUDE.md` (platform registry, Bandcamp probing, artist bios, typecheck coverage). This file holds the rules for the Netlify functions, in this order:

1. What is here — the Sentry wrapper and the `db.ts` barrel
2. Search flow
3. Redis is metered
4. Reading the database
5. API middleware & security — and the `endpoint()` wrapper new endpoints are written with
6. Auth on the server
7. Account settings, claims, admin tools, artist analytics, the v1 API
8. Releases and the catalogue — ingest, the sweep, dedup, collections
9. Artist patronage (tips)
10. Notes kept in other files

## What is here

- **`api/functions/`** — Netlify serverless functions, **the live backend**: `search-sources.ts` (Phase 1 orchestration, the big one), `search-musicbrainz.ts` (Phase 2), `search-utils.ts` + `search-parsers.ts` (pure, unit-testable logic), `middleware.ts` (CORS, auth, validation, SSRF allowlist), `cache.ts`, `ratelimit.ts`, `db.ts` (service-role Supabase), `__tests__/`. **`db.ts` is only a barrel**: the helpers live in `api/functions/db/`, one module per area (`client`, `artists`, `search-persist`, `admin-lists`, `catalog`, `release-persist`, `release-review`, `release-curation`, `bandcamp-probes`, `release-reads`, `release-feeds`), and everything else keeps importing from `./db`. Add a helper to the module it belongs with. Modules in `db/` import each other directly (`./client`), never through `../db`: tests mock that path, and a module importing through it would be handed the mock. Never add `db/db.ts` or `db/index.ts`: Netlify would deploy the folder as a function.

**Every function in `api/functions/` must export its handler through `withSentry`** (`export const handler = withSentry(endpoint({...}, handleRequest))`; the `endpoint()` wrapper is under "API middleware & security"): an invocation can be torn down the moment it has answered — on Lambda the process froze outright — so without the flush it adds, events captured just before returning never reach Sentry. `with-sentry.test.ts` fails on a function that forgets. `api/lib/sentry.ts` must import `@sentry/node`: only its `init()` binds a client on Netlify's functions, and an SDK without it drops every server-side event silently (`sentry-client-binding.test.ts`).

To run these from a worktree, `npm run dev` needs `--functions "$PWD/api/functions"`: `api/CLAUDE.md`, "Running `npm run dev` from a worktree".

## Search flow

Two-phase.

- **Phase 1** — `GET /api/search/sources` → `search-sources.ts`. Fans out across platforms in parallel (~1-2s), aggregates, disambiguates, returns results. Applies MusicBrainz enrichment server-side when it has it; `hasPendingEnrichment` tells the client whether Phase 2 is still needed.
- **Phase 2** — `GET /api/search/musicbrainz` → `search-musicbrainz.ts`. Official sites, socials, location, release verification, Qobuz links. Merged client-side by `mergeWithMusicBrainzData` in `apps/web/src/services/sources.ts`.

**Both phases share one MusicBrainz enrichment and one cache entry** (`musicbrainz-enrichment.ts`, key `mb-enriched`, kept a day — not longer, since "no such artist" is cached too and new artists join MusicBrainz constantly). On a miss it is the slowest leg of a search by far, so a client sends `enrichment=deferred` and Phase 1 only *reads* that cache, never fetches: on a miss it returns without MusicBrainz and Phase 2 fills the cache for the next search. **Only the web client's single-artist search sends `enrichment=deferred`**; every other caller gets Phase 1 waiting on MusicBrainz inline, and don't make deferral the default. Of those, the v1 API, Discord bot, edge pages and the web client's multi-artist split never call Phase 2 at all. The Mac app and extension call it only when `hasPendingEnrichment` comes back true, and `scripts/generate-artist-data.ts` calls it every time and merges the result itself. Each Phase 1 logs a `[search-timing]` line and sends a `Server-Timing` header with per-phase durations; read those before guessing where a slow search went.

**Phase 1 doesn't wait for its database writes.** `persistSearchResults` runs in `persist-search-results-background`, handed off by `request-persist.ts` (one 202 handshake, to the site's `netlify.app` host because Cloudflare's Bot Fight Mode challenges Lambda calls to `unstream.stream`). Nothing in the response may depend on those writes; any failed handoff persists inline and warns, and `persist`'s Server-Timing desc says which happened.

**Artists we already hold are shown first.** The web client calls `GET /api/search/stored` (`search-stored.ts`, database reads only) alongside Phase 1 and renders those claimed and verified cards while the fan-out runs. Both endpoints build them with `findStoredArtists` (`stored-artists.ts`), so the early cards carry the same ids as the full results' and are updated in place under `key={result.id}`. Keep it that way: `ResultCard` records a search appearance on a claimed artist's dashboard each time one *mounts*, so an id that differs between the two would count every search twice.

**Same name, different Bandcamp account = different artist.** Wherever two results meet by name — MusicBrainz enrichment on the server (`applyEnrichmentToResults`) and in the browser (`mergeWithMusicBrainzData`), and stored artists folded into live results (`mergeStoredArtistsIntoResults`) — a Bandcamp subdomain on both sides that differs means they stay separate cards (`bandcampSubdomainConflicts`, `api/shared/bandcamp-identity.ts`, shared by Node and the web client). The extension (`apps/extension/lib/bandcamp-identity.js`) and the Mac app (`UnstreamAPI.swift`) keep copies for their own Phase 2 merges; `bandcamp-identity-copies.test.ts` and `BandcampIdentityTests.swift` pin them to the same cases, so change all three together. `generate-artist-data` does its own Phase 2 merge too, and needs the same check. Honeycrush (Brooklyn) / Honey Crush (Orlando) is the standing example; deferring MusicBrainz to Phase 2 once reintroduced it because the browser merge lacked the check.

**When MusicBrainz lists several artists under the exact name, the name stops being evidence.** The enrichment records them as `homonyms` (looking up links for the two best-ranked people or groups), and every merge above then needs the *same* Bandcamp account on both sides (`nameMatchIsSameArtist`, same three copies); the matched artist and each homonym with a Bandcamp, official site or Qobuz link get a card of their own instead. Since the `artists` row is keyed by its slug, same-name cards are stored at addresses that tell them apart — their Bandcamp account (`xparacosm`), else name and MusicBrainz city (`paracosm-orlando`), else not at all — decided once per search by `recordSlugs` and used for both the save and the card's page/Claim/save links; a stored row with no Bandcamp finds its card again by that address. Paracosm — Los Angeles (`xparacosm`), Orlando, Sofia — is the standing example: it showed one card made of two bands, and none for the artist who reported it.

Multi-artist queries ("Artist feat. Artist2") are split, searched in parallel, then merged and deduplicated — by the web client only (`parseMultiArtistQuery` / `mergeSearchResponses` in `sources.ts`); the server, v1 and the apps never split.

`search-sources.ts` holds orchestration and per-platform fetchers, and is already large. `search-utils.ts` holds the pure helpers (`aggregateResults`, `splitSuspiciousPlatforms`, `mergeByReleaseOverlap`, `filterAndSort`, `applyMergeOverrides`) and `search-parsers.ts` the per-platform parsers. **Prefer adding logic there with a test over growing `search-sources.ts`.**

## Redis is metered — count round trips, not just correctness

Upstash's free tier is **500,000 commands a month** (~16,600/day) — a *command* budget — and the site exhausted it in August 2026 at low traffic. One user search costs ~10 API requests, so any per-request Redis overhead is multiplied by ten. Four rules:

- **Every extra limiter has to earn its round trip.** Of `checkRateLimit`'s tiers, only `strict` (10/min) adds a daily quota — it fronts search (both phases draw on it, so a deferred web search spends two tokens), and its 500/day is a documented promise to anonymous v1 callers (`docs/openapi.yaml`). `standard`, `lenient`, `account` keep per-minute windows only (30/120/60). API-key tiers in `checkApiRateLimit` have their own minute and daily quotas (free 30/min + 100/day, pro 100/min + 10,000/day, internal 300/min).
- **Batch reads that share a request.** `cachePrefetch` reads the fan-out's per-platform keys in one `MGET` and passes each fetcher its value via `cacheGetOrFetch`'s `prefetched` argument; fetchers keep their own TTLs, predicates and write-backs. Add new cached platforms to that key list in `searchAllPlatforms` rather than issuing a separate `GET`.
- **Never spend two commands answering one question.** `checkSentryDedup` is a single `SET ... NX EX`. Prefer `SET NX`, `INCR`, `MGET` over read-then-write pairs.
- **Don't cache a constant** — only a real fetch is worth protecting.

`getMergeOverrides` / `getLinkSuppressions` are the one sanctioned in-process memo (global, tiny, read on every search): 60 seconds in `db/admin-lists.ts` on top of Redis, short enough that `invalidateAdminListCache` keeps its meaning. Don't generalise it.

## Reading the database

**Paging, not `.limit()`.** PostgREST caps every response at 1,000 rows whatever limit you ask for, and truncates *silently* — a `.select()` over `artist_links` returns 1,000 of ~3,900 rows and looks successful. Use `readAllPages` (or `.range()` in a loop) for any read whose table can exceed 1,000 rows.

## API middleware & security

`api/functions/middleware.ts` centralizes CORS (`buildCorsHeaders` / `buildPublicCorsHeaders`), auth (`authenticateBearer`, `authenticateBearerFast`, `authenticateAdmin`, `authenticateApiKey`, `isInternalRequest`), query validation (`validateQuery`), v1 envelopes (`v1Response`), and SSRF protection.

**Every endpoint is written with the wrapper, `endpoint()` in `api/functions/http/endpoint.ts`.** It declares what it is in one plain object (`cors`, `methods`, `auth`, `rateLimit`, `jsonBody`) and supplies a function that is handed `{ method, user, body, query, headers, path, ... }` and returns `{ status, body, headers? }`. The wrapper answers the preflight, refuses other methods with 405 (HEAD is answered wherever GET is, as a GET), authenticates, rate-limits, parses the JSON body, and puts the CORS headers on every answer, its own refusals and a thrown error's 500 included. It exists because every handler used to choose those pieces separately, and the two gaps found on 2026-11-16 (`claim-artist.ts` skipping the two-step check, 20 signed-in endpoints answering `*`) were both a handler choosing wrong. All 76 functions are on it since 2026-11-16, and `endpoint-wrapper-adoption.test.ts` fails on one that isn't, or that still builds CORS, checks a token, calls the rate limiter or reads `httpMethod` by hand. What to know:

- **`auth` picks an existing function, never new logic:**
  - `'none'` — anyone.
  - `'optional'` — anyone, and the function is handed the signed-in user when there is one (`tips-checkout`, to credit a tip to the fan's account). It has no `'public'` CORS either, and its limit is counted under `ip:<address>`, apart from the bare-address budget search draws on, so a fan who has just searched a lot can still start a payment.
  - `'account'` — `resolveAccountRequest`, the fast local check; for fan endpoints the Mac app and extension call.
  - `'accountWithSecondStep'` — the same, then `sessionMissingSecondFactor` (a 403). **For anything that acts as an artist, moves money or changes the account.**
  - `'bearer'` — `authenticateBearer`: the token is checked against Supabase on every request, and a session that owes its second step is refused (a 401). For where a revoked session must stop at once: claiming, an artist's profile and releases, payouts, API keys, the password.
  - `'admin'` — `authenticateAdmin`.
  - `'apiKey'` — the v1 API: an optional `X-API-Key` picks both the CORS answer and the quota (`authenticateApiKey`, `checkApiRateLimit`), with `envelope: 'v1'` wrapping every answer as `{ data, meta }`.
  - `'internal'` — `isInternalRequest`: our own functions and workflows, with `INTERNAL_FUNCTION_SECRET`.

  A signed-in endpoint can't be declared with `cors: 'public'`: the types refuse it.
- **It spends the Redis commands the hand-written handlers did, and no more:** one rate-limit call per request, and none for admin or internal. `rateLimit` is a tier, counted against the account for `'account'` modes and against the IP otherwise (for `'bearer'`, before the Supabase round trip, so a flood never reaches it). `'none'` is for an answer that costs nothing to produce. A function of the method picks a tier per method (`tips-checkout`: strict for POST). `{ tier, by: 'ip' }` on an account endpoint counts against the IP before the token is read, for a path that checks a credential (`me-bandcamp`'s POST). A method the wrapper refuses costs nothing.
- **An answer that isn't JSON is `{ status, raw, headers }`** (a feed, an image, a redirect), and `cors: 'none'` is for what no browser on another origin calls (the Stripe webhook, the feeds, the internal functions). `rawBody` is the body as sent, for a signature check.
- **One endpoint per file.** Where one path of a function was a different kind of endpoint, it became a function of its own: the Buffer OAuth callback (`me-buffer-callback.ts`: public, answers with a redirect) beside the signed-in `me-buffer.ts`, routed ahead of it in `netlify.toml`.
- **Two endpoints share their work with the v1 API as a plain function, not through each other's handlers:** `searchSources` (`search-sources.ts`) and `resolveUrl` (`resolve-url.ts`). The v1 functions call those directly behind their own key check and quota, so one request is never counted against two limits.
- Still export through `withSentry(endpoint({...}, handleRequest))`. `http/` is typechecked by `api/tsconfig.json` (`functions/http/*.ts`), and must never gain `http/http.ts` or `http/index.ts`, for the same reason as `db/`.

**CORS has three shapes, which an endpoint picks with `cors`** (`'site'` or `'siteOrApiKey'`, `'account'` or `'accountAndExtension'`, `'public'`; `'none'` sends no CORS at all). `buildCorsHeaders` (v1, admin) restricts anonymous callers to `https://unstream.stream` and opens up for API-key requests. `buildAccountCorsHeaders` (`account-cors.ts`) is for every endpoint a signed-in person calls with a Bearer token (the `me-*` endpoints, saved artists, claim, artist profile, artist analytics, the artist side of tips): it echoes only the site and the local dev origins, never `*`, and on `saved-artists` and `saved-artists-sync` also the browser extension's own origin, because the extension's popup calls those two and can't count on its host permission (Firefox makes it optional). `account-cors.test.ts` holds each of them to it. `buildPublicCorsHeaders` (search, the public artist and release reads, the analytics beacons, `platforms-list`, `api-status`) sends `Access-Control-Allow-Origin: *`, with no `Vary: Origin` since the answer is the same for everyone; `collection-art` and `public-saved-artists` are on it too, and their comments say why. `collection-art` takes no sign-in token: its answer is cached at the CDN by URL, so whatever decides access (the `?t=` token) has to be in the URL.

SSRF protection starts with an **explicit hostname allowlist** — `ALLOWED_OUTBOUND_HOSTNAMES` + `isUrlHostnameAllowed()`. Every outbound fetch must pass it, and a new platform fetch means adding its hostname (wildcards like `*.bandcamp.com` work). It also blocks non-HTTP(S) schemes, localhost and private and metadata IPs. Its comments record *why* hosts were removed (e.g. no `qobuz.com`: robots-disallowed, links come from MusicBrainz relations and are displayed but never fetched) — preserve that reasoning when editing. **A hostname check alone is not an SSRF boundary**: any URL that came from a request, a database row or scraped markup goes through `safeFetch` (`api/functions/safe-fetch.ts`), which follows redirects by hand, re-validates every hop, and requires every resolved IP to be public (`169-254-169-254.nip.io` passes a string check). `check-releases`, `catalog-artist-background` and `artist-photo-refresh` use it.

Rate limits and Sentry dedup live in `ratelimit.ts` (`checkRateLimit`, `checkApiRateLimit`, `checkSentryDedup`).

The rules these implement ("Security practices") are in the root `CLAUDE.md`.

## Auth on the server

Sign-in itself (magic links, passwords, passkeys, two-step verification) happens between the browser and Supabase Auth and is described in `apps/web/CLAUDE.md`, "Sign-in, two-step verification and passkeys". There, `AuthContext` renders `MfaChallengeGate` in place of the whole app until a second step is answered.

That gate is only UI, so every endpoint a takeover would use refuses an aal1 session for an account with a verified factor. An endpoint gets that by how it is declared (`endpoint()`, above): `auth: 'bearer'` (`authenticateBearer`: `artist-releases`, `artist-profile`, `claim-artist`, `tips-connect`, `tips-settings`, `api-key-generate`, `me-password`), `auth: 'admin'`, or `auth: 'accountWithSecondStep'` (`sessionMissingSecondFactor`: `me-email`, `artist-promote`, `artist-campaigns`, `artist-promote-assets`, `me-buffer`). **New endpoints that act as an artist, move money or change the account need one of those three.** Fan endpoints the Mac app and extension call (saved artists, sync, listening) still accept aal1, because neither app can answer a challenge yet.

On the server:

- **Account endpoints** (`me-*`, `saved-artists`, `saved-artists-sync`, `user-sharing`) authenticate and rate-limit through `resolveAccountRequest` (`ratelimit.ts`), which verifies the JWT locally (`authenticateBearerFast`) — a revoked session keeps working for up to an hour (#331).
- **Where a fresh check matters, make the round trip to Supabase:** `auth: 'bearer'` (`authenticateBearer`) or `'admin'`, for the endpoints listed above. `me-settings` is on the fast check like the rest of `me-*`, and then reads the account's current record (its email as it is now, and whether it has a password) from the auth server, since a token carries neither reliably.
- **Admin** is the `ADMIN_EMAIL` env var on the server; `AuthContext` hardcodes the same address only to show admin UI.
- **Function-to-function calls** (background jobs, the sweep) carry `INTERNAL_FUNCTION_SECRET`, checked by `isInternalRequest`. They go to `internalFunctionOrigin()` (`api/lib/internal-origin.ts`, the site's `netlify.app` host), never `URL`, which is behind Cloudflare, and only a 202 counts as delivered: a bot challenge's 403 once made six days of catalogue requests look sent ("The six days nothing was catalogued", engineering history).

## Account settings

`/settings` is backed by the `me-*` functions (`me-settings`, `me-username`, `me-location`, `me-password`, `me-notifications`, `me-bandcamp`) plus `user-sharing.ts`; `me-tips` backs its Tip History section; `me-feed-token` backs the Release calendar on `/my-saved-artists` instead. Each should have a test in `api/functions/__tests__/`, which is typechecked by being there — **follow that pattern for new account endpoints.** The "Two-step verification" section (`id="two-step"`, below Password) is the exception that needs no backing function: it talks to Supabase Auth directly from the browser.

## Claiming an artist

The claim wizard is described in `apps/web/CLAUDE.md`, "Artist profiles". The rule the server enforces:

**A link-back verifies instantly only on a website we already hold for the artist** (a non-`claimed` `officialsite` or `bandcamp` link, `claim-verification.ts`); on any other site it files a `verification_requests` row for `/admin/verify` instead. The link-back alone proves only that the claimant controls *some* page, and verifying on it let anyone claim an unclaimed artist and swap in their own payment links. Don't loosen it for convenience.

## Admin tools

Admins (the `ADMIN_EMAIL` env var on the server) merge duplicate results at `/admin/merge`, review verification and merge duplicate artist rows at `/admin/verify`, approve artists' tips accounts at `/admin/tips` (split out of `/admin/verify` on 2026-11-08; its menu count comes from the database-only `/api/admin/tips?summary=1`, never the full list, which calls Stripe per account), suppress a single wrong link at `/admin/links`, work the tier-3 dedup queue at `/admin/release-review`, and view `/admin/analytics`. **`/admin/analytics` reads `app_events` for any date range** (`analytics-range.ts`; raw rows are kept 90 days, then `rollup_app_events()` folds them into `app_events_daily`, so every count goes through the `analytics_*` SQL functions, which read both — never a direct count of `app_events`). A `search` event carries `search_kind` (`typed` or `now_playing`) from every client, and extension events carry `browser`; the extension counts a now-playing search once per listening stretch with an artist (`apps/extension/lib/search-tracking.js`), not per track as it did before 2.10. Website traffic beside it comes from GoatCounter's API (`analytics-traffic.ts`, `GOATCOUNTER_API_TOKEN`), in its own endpoint so a GoatCounter failure can't blank the search numbers. Merge overrides live in Supabase (migrations 004–005), are respected during disambiguation, and can be managed with `npx tsx scripts/merge-override.ts`. **What waits on the admin is pushed to his phone** through Pushover (`sendAdminPush`, `api/functions/admin-push.ts`, keys `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY`): a claim filed for review, at the moment it's filed (`claim-artist.ts`), and an artist awaiting tip approval, by the `tips-review-notify` cron. **Keep it on a hosted service.** It used Brandon's self-hosted ntfy until 2026-10-27, and the first real claim push never arrived: that server is on his Mac Studio behind a Cloudflare tunnel, and a Netlify function can't count on getting through. Never write his home server's address or topic into this public repo.

## Artist analytics

`/analytics/:slug` (`ArtistAnalytics.tsx`, backed by `GET /api/analytics/stats`) shows a period's totals and, under them, the last 30 days as an **activity list** (`artist-activity.ts`): most claimed artists see single-digit numbers a month, and listed one by one they read as things that happened rather than a dashboard of zeros (Brandon, 2026-11-08). The list is **day-level and count-only** — never a time, never a fan, and no locations at all (Brandon, 2026-11-08): at these sizes either would identify a friend. It draws on `artist_analytics`, current saves and supported marks, collection items linked to the artist's releases (not hidden ones), paid tips (kept-after-refund amounts, current Stripe mode) and sent release alerts (`email_log`, `new_release`). Two `artist_analytics` metrics exist for it: `streaming`, sent **instead of** `search` when the extension or Mac app's now-playing lookup shows a claimed artist (once per listening stretch, extension 2.10+; "Heard while streaming", and part of the search total), and `release_view:<release id>`, posted by an inline script on the release page (`api/shared/release-view-beacon.ts`; the page is CDN-cached for an hour, so only the browser knows it was viewed) and accepted only for a release that belongs to the slug's artist. Streaming counts start only once those app versions ship; older ones still send `search`.

## Public API (v1)

Documented in `docs/openapi.yaml`, surfaced on `/developers`, routed in `netlify.toml`: `/api/v1/search`, `/artist/*`, `/resolve`, `/platforms`, `/status`, `/keys`. Keys are stored hashed (migration 007); key-bearing requests get permissive CORS, anonymous ones are restricted to `unstream.stream`.

## No Discord bot

It was removed on 2026-10-04: it had no users, and its background function was publicly callable with the bot token attached. Don't bring it back without auth on every hop.

## Listening signals

`me-listening.ts` takes the Mac app's Apple Music library scan into `listening_signals` and serves the private "gap report" (artists you play a lot and have never paid).

## Releases and the catalogue

### Testing release ingest locally

Cataloging only runs where `RELEASE_CATALOG_ENABLED=true`, set for the **Production context only**. Previews and local runs both point at **production** Supabase, so **setting the flag locally is not a valid workaround** — it would have your laptop writing production data and spending the real crawl budget. Use `npm run ingest:try -- <artist>` instead (`--json` for full row shapes, `--detail=3` for dates, formats and prices): it exercises the real fetcher, allowlist check, parser and mapping without touching the database. One Bandcamp request per run, plus one per release page with `--detail`; don't loop it.

There is deliberately no `--write`; to test the write path, point `SUPABASE_URL` at a branch database on purpose. And **don't reach for `CONTEXT` or `DEPLOY_PRIME_URL` in a function** — Netlify exposes only `URL`, `SITE_NAME` and `SITE_ID` at runtime, so an earlier `CONTEXT === 'production'` gate silently disabled cataloging entirely.

`release_catalog_state` is the observability surface (`last_attempted_at`, `releases_found`, `last_error`, `consecutive_failures`, `last_trigger`); `recordCatalogOutcome` reports a sudden drop to 0 releases to Sentry, since a parser break otherwise looks like an ordinary success.

Rendering a release page locally is in `api/edge/CLAUDE.md`, "Seeing the release page locally".

### Keeping catalogues fresh

Catalog triggers are all demand-driven — a save, an artist's own button, the admin command, a collection import — and `check-releases` only *reads* the catalogue, so without a scheduled refresh an artist saved once is catalogued once and their alerts quietly stop. `api/functions/recatalog-sweep.ts` fixes that, run every twelve hours by `recatalog-sweep.yml` at 25 artists per run (50 a day).

**Search is deliberately not a trigger, directly or via the sweep** — queuing a crawl per Bandcamp-linked search result made an unauthenticated path the site's largest producer of database writes and exhausted the Supabase disk I/O budget; letting every searched artist into the sweep's pool did the same one step removed (the pool grew ~46 artists a day against the sweep's 50, so nearly every slot was a first-time crawl). Don't reintroduce either. The off-switch is the `RELEASE_CATALOG_ENABLED` env var — deleting it in Netlify stops cataloging with no deploy.

**The sweep's attention is demand-gated.** An artist gets a *first* catalogue only if they are saved by a fan, hold a verified claim, or appear in a connected Bandcamp collection — and since disk I/O round 6 (2026-09-19) the same three signals gate the *refresh* too: an artist already catalogued whom nobody follows is frozen rather than re-crawled (their `release_catalog_state` row stays, their page keeps showing the stored catalogue; prices go stale, the page does not empty). Everyone else with a crawlable link is counted as `awaitingDemand` (never catalogued) or `frozenCatalogues` (catalogued, frozen) in the sweep's log and left alone. Crawlable means **a real bandcamp, discogs, faircamp, jamcoop or mirlo link** (`CATALOGUEABLE_PLATFORMS` in `catalogueable-platforms.ts`) — `isCatalogueableLink` also excludes the `bandcamp.com/search?q=` placeholder links, which were once the only failures in `release_catalog_state`. **The sweep and `catalogArtist` read that one list** (`hasCatalogueableLink`), because an artist with only an official site is recorded as a *failure*, so sweeping them poisons `consecutive_failures`. The placeholder-link rule is the one part still written twice, in `isCatalogueableLink` and in the SQL of `stale_catalog_candidates`; change those together. The sweep asks `requestArtistCatalog` for up to 25 under the `scheduled` trigger, but `claimArtistForCatalog` (7-day cooldown plus per-trigger hourly cap) is the authority, so running it twice is a no-op.

**The Bandcamp pass also repairs a deleted artist photo.** Search never writes to a claimed artist's row, so their `artists.image_url` stays what it was when they claimed, and Bandcamp deletes the old file when they change their photo. `refreshDeadArtistPhoto` (`artist-photo-refresh.ts`) replaces it with the `/music` page's `og:image`, but only when the stored photo answers 404 or 410, the page's band name matches the artist, the new photo is on Bandcamp's image host, and they haven't set their own `custom_image_url`. It only ever replaces a stored photo — an empty `image_url` is never filled — and the write is guarded on the old URL (`replaceArtistPhoto`), so a newer search result wins. It is the one write the pass makes to a claimed row, allowed because `image_url` was never the artist's choice, and it leaves `updated_at` alone.

### Release dedup: what identity is, and what the date is for

One release exists on several platforms, described differently by each. **Under-merge, never over-merge** — a false merge asserts an artist made a record they didn't, and nobody would ever catch it. Before any tier, ingest asks whether the incoming listing is **already a source** on one of the artist's releases (`findReleaseBySource`, #554): if so it is that release, whatever its title says. Without it, a listing titled differently from the stored row (Mirlo's "Luminaires (single)" against a stored "Luminaires") made a phantom row that came back for review on every re-catalogue. Then three tiers:

1. **A hard identifier** (`discogs_master_id`, `musicbrainz_release_group_id`) — someone else's "these pressings are one album" conclusion. Wins outright.
2. **Identical `match_key`, unless the dates disagree** (`findExactReleaseMatch`). Merges.
3. **Containment between match keys, unless the dates disagree** (`findFuzzyReleaseMatch`). Never merges — flags both rows `needs_review` for `/admin/release-review`. Runs for Discogs, Faircamp, Jam.coop and Mirlo; the Bandcamp grid carries no dates and only matches exactly.

Writes follow three more rules (`persistReleases`): never overwrite a stored value with null, never touch a column listed in the release's `curated_fields` (what a verified artist edited), and if a new release's source write fails, delete the release in the same pass (#555 — 676 source-less releases had built up before that guard). Faircamp also catalogues only the releases the site's homepage credits to the artist by name (an empty credit means the site's own artist), so a label's Faircamp no longer hands its whole catalogue to whichever artist was crawled first.

Three measured rules hold the tiers together:

- **Release type is not identity, and restoring it would be a regression.** Discogs has no type field for a master, so 92% of its rows are `other` where Bandcamp says `album`; keying on `(release_type, match_key)` left 1,181 identical-title pairs (931 with no date saying they differ) duplicated on artist pages, unmerged and almost never flagged.
- **`releaseDatesDisagree` replaces it, and cuts both ways.** It compares only as far as the *coarser* precision vouches for — hence the stored `date_precision`, since a Discogs bare year arrives as `2020-01-01`. **A missing date is never disagreement.** As a veto it also keeps the review queue usable.
- **A release may hold several sources per platform.** Uniqueness is `(release_id, platform, COALESCE(external_id, ''))` — at most one id-less source per platform, since two of those can't be told apart. Global `UNIQUE (platform, external_id)` is untouched and keeps re-crawls idempotent.

Two consequences of that last rule: **render every "where to buy" list through `oneSourcePerPlatform`** (`api/shared/release-display.ts`, Node + Deno) or `orderedSourcePlatforms`, or you print "Discogs · Discogs" and one payout twice; and **`persistDiscogsReleases` must look up master ids in `release_sources` too**, since `releases.discogs_master_id` holds only the survivor's — without it the next pass re-creates the merged-away master and the review queue refills forever.

Rule changes only affect tomorrow: ingest compares what it is *writing* against what is stored. `npm run dedupe:releases` applies current rules to the existing catalog — report-only by default, `--write` to apply, merging through `mergeReleases`.

### Collections, and why most items start unlinked

**Bandcamp collection.** `/settings` connects a fan's Bandcamp account through `me-bandcamp.ts`, which stores encrypted Subsonic credentials (`credential-crypto.ts`); `bandcamp-sync-background.ts` imports, `me-collection.ts` hides items, `collection-art.ts` proxies cover art at `/api/collection/art/*`. Matching is under "Collections" below.

A Bandcamp import (`bandcamp-sync-background.ts`) writes a `collection_items` row per album and attaches a release only when one already exists, so most of a real collection arrives unlinked — the fan bought from artists nobody has ever searched.

**There is no source URL to fall back to.** Bandcamp's Subsonic API returns `id`, `name`, `artist`, `coverArt`, `year`, `genre`, `created` and nothing else, so "just link to Bandcamp" isn't available and deriving `<artist>.bandcamp.com/album/<title>` mints 404s. Don't reach for it.

`collection-matching.ts` closes the gap in two halves: `resolveCollectionArtists(userId)` at the end of a sync, on **both** the success and failure paths (it touches neither the Subsonic API nor the credential, so a Subsonic 500 must not block discovery), and `linkCollectionItemsForArtist` at the end of every catalogue pass, attaching releases to waiting items forever after.

Matching is exact on `releases.match_key` via `releaseMatchKey`, the function that produced the column. **Use that one, never `normalizeForComparison`**: it strips to `[a-z0-9]`, so a title with no Latin characters normalizes to empty and can never match. A near-miss stays unlinked on purpose — a collection page asserts a specific person bought a specific record.

## Artist patronage (tips)

**Patronage (tips).** One-off tips through each artist's own Stripe account, live on `main` since #575 and open to artists since the `tipsArtists` and `tipsFans` flags went on (several artists have enrolled); see "Artist patronage (tips)" below. A fan's own tips are the **Tip History** section of `/settings` (`me-tips.ts`); `/tip/thanks` deep-links to `/settings#tips`.

Spec: `docs/specs/artist-patronage-spec.md`. **Money never sits in Unstream's Stripe balance except Unstream's own application fee** — every payment is a direct charge on the artist's own Standard connected account (§2 "The line"). Don't build anything that holds, pools, forwards or conditionally releases money; that's money transmission.

- **Phase 1 ("I'd tip them", Play my city) was dropped** (Brandon, 2026-09-28): a demand test for something artists can already get through their own Ko-fi/Patreon links, and too little traffic for city counts to mean anything. Don't rebuild it without a new decision.
- **Phase 2 (one-off tips):** `stripe.ts` (fetch client behind the SSRF allowlist, signature check), `tips-db.ts` (`tipEligibility` is the single definition of "can take a tip"), `tips-connect|settings|checkout|webhook.ts`, `admin-tips.ts`. Fee math in `api/shared/tips.ts`, used by server and tip page alike; the server recomputes every figure.
- **The fan's side needs no account.** A signed-out tip is still a tip; the sign-in offer comes *after* paying, on `/tip/thanks`, which saves the tip to the account by its Checkout Session id (`POST /api/me/tips`: only a paid Unstream session for that artist, under a day old, that nobody has claimed). Signed-in fans see their tips in `/settings` (`YourTips`, hidden until there's one). The webhook sets the charge's `receipt_email` from Checkout's email so a receipt always arrives — passed to Stripe, never stored. Refunds are the artist's; Unstream has no refund button.
- **`livemode` on every Stripe-backed row.** `npm run dev` writes to production Supabase with a test key, so accounts are keyed `(artist_id, livemode)` and every read filters on the key's mode (`isLiveMode()`). Test keys in every Netlify context but Production.
- **Tips are open to artists through two runtime flags** (`feature-flags.ts`, switched at `/admin/flags`): `tipsArtists` gates the artist side (Stripe onboarding, switching tips on) and `tipsFans` every fan-facing surface. Both are on, and several artists have enrolled (2026-10-29). The admin account passes the artist gate even with the flag off (`canSetUpTips` in `tips-db.ts`, from when tips were private to it, 2026-10-03). Fans still only get a Tip button for an artist an admin approved, and that approval, not either flag, is what limits who can be paid.
- **Webhook status only moves forward.** Stripe doesn't order events, so every `tip_payments.status` write is conditional on the status it leaves (succeeded → refunded/disputed; disputed → succeeded only on a won dispute; refunded → succeeded only when a refund fails). Rows are created only by `checkout.session.completed`; `payment_intent.*` is ignored, and events from the other Stripe mode are dropped up front. Partial refunds live in `refunded_cents`, and **every money figure counts `amount − refunded share`** (`keptAfterRefund` in `api/shared/tips.ts`, the same arithmetic in `get_goal_progress` / `get_artist_tip_totals`). Unstream's fee goes back in proportion on refunds and in full on a lost dispute. Subscribed events are listed at the top of `tips-webhook.ts`.
- **Disconnecting isn't final:** `account.application.deauthorized` sets `deauthorized_at`, which reads everywhere as "no account"; reconnecting creates a new Stripe account into the same row with approval reset. Goals carry `livemode` too. No Unstream fee in BR/MY/TH (`NO_APPLICATION_FEE_COUNTRIES`: Stripe forbids it there).
- **Tips ship dark:** with no `STRIPE_SECRET_KEY`, the Tips button on `/my-artists` doesn't appear (`/api/tips/settings?summary=1` says so) and no Tip button appears anywhere.
- **Each thing an artist manages is its own page** (`/tips/:slug` for tips, where Stripe onboarding returns): `apps/web/CLAUDE.md`, "Artist management pages". The old tab addresses still redirect; don't remove them.
- **Phase 3 (the tab): the gate passed** in test mode on 2026-10-03 (`docs/specs/artist-patronage-phase3-gate.md`): cloning a saved card to an artist's account and charging it off-session works, and a fresh clone per run needs no extra table. Not built; building it is Brandon's decision.
- **A live Stripe key under `npm run dev` switches tips off.** `stripeMode()` returns null (which
  every caller reads as "tips are off") for a live key when `isProductionSite()` is false, and
  reports it once. **Netlify deploy previews are not covered:** a preview's `URL` is the
  production address, so the Deploy Preview context must keep its test key.
  `api/lib/production-site.ts` is the one definition of "production" that this and the Sentry
  environment use.

## Notes kept in other files

- **Feature flags** are read here (`feature-flags.ts`), and every flagged endpoint shares a gate function. The rule is about what the browser may decide, so it is written up in `apps/web/CLAUDE.md`, "Feature flags: the server decides, everywhere".
- **Release alerts and feeds** (`check-releases.ts`, `notifications.ts`, `feed-releases.ts`, `me-feed-token.ts`): `apps/web/CLAUDE.md`, "Release alerts and feeds". A feed token is minted only on an explicit press.
- **Saved artists and public lists, the artist menu (`me-artist-nav.ts`), newsletter signup, the widget, `purge-cache.ts`**: the matching entries under "Feature surfaces" in `apps/web/CLAUDE.md`.
- **`social-card.ts`**: `scripts/CLAUDE.md`, "Social posts".
- **`platforms-list.ts`** is one of the platform registry's hand-kept copies: `api/CLAUDE.md`, "Platform registry".
- **Function-to-function calls and Cloudflare**: "Auth on the server" above; the incident is in `docs/engineering-history.md`.
