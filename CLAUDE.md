# Unstream - Development Guide

## Project overview

Unstream helps music listeners find their favorite artists on alternative platforms outside streaming, so they can support artists directly. It searches 17+ platforms (Bandcamp, Mirlo, Ampwall, Subvert, Beatport, Faircamp, Jam.coop, Patreon, etc.) and shows verified links grouped by category with artist payout percentages. On Bandcamp Fridays, results highlight the platforms that pay artists 100%. Runs at [unstream.stream](https://unstream.stream).

**`docs/engineering-history.md` holds the evidence behind the rules in this file** — the measurements, incidents and abandoned approaches that produced them. Read it before changing a rule, or when one looks arbitrary.

## Mission, vision, and values

**Mission:** To deepen the connection between fans and artists so appreciation turns into lasting support.

**Vision:** A world where more people support the arts and where more artists are sustainably supported.

**Values:** Unwavering respect for artists · Patience · Curiosity · Transparency

**Operating principles:** Artists first, supporters second · build for connection, not just transaction · solve from first principles, don't be afraid to be scrappy · no ego in the face of conflict.

These inform engineering trade-offs, not just marketing copy — when a decision pits fan convenience against artist payout or transparency, artists first wins.

## Architecture

- **Frontend**: React 19 SPA, React Router 7, Tailwind CSS v4, Vite 7, TypeScript. PWA-enabled (`vite-plugin-pwa`); most pages lazy-loaded in `apps/web/src/main.tsx`.
- **Backend**: Netlify Functions (serverless API, `api/functions/`, Node) + Edge Functions (SSR/SEO, `api/edge/`, Deno — see `deno.lock`).
- **Database**: Supabase (Postgres with RLS) — artist profiles, analytics, merge overrides, API keys, verification requests, saved/supported artists, public usernames, releases, collections, Bandcamp probe cache.
- **Enrichment**: MusicBrainz, Wikidata, Wikipedia, Discogs, Linktree, Bandcamp artist pages. **Caching / rate limiting**: Upstash Redis. **Monitoring**: Sentry (`apps/web/src/services/sentry.ts`, `api/lib/sentry.ts`). **Analytics**: GoatCounter + custom Supabase analytics. **Email**: Resend for transactional mail (`api/lib/resend.ts`, `notifications.ts`) — release alerts, claim decisions.
- **Integrations**: public REST API (v1), Discord bot, social post automation, ListenBrainz scrobbling (Mac app only; the backend has no ListenBrainz code).
- **Clients**: web app, universal Apple app (macOS menu bar + iOS, SwiftUI), browser extension (Chrome + Firefox, MV3). **Hosting**: Netlify.

## Repository structure

Only the non-obvious parts; `ls` covers the rest.

- **`api/functions/`** — Netlify serverless functions, **the live backend**: `search-sources.ts` (Phase 1 orchestration, the big one), `search-musicbrainz.ts` (Phase 2), `search-utils.ts` + `search-parsers.ts` (pure, unit-testable logic), `middleware.ts` (CORS, auth, validation, SSRF allowlist), `cache.ts`, `ratelimit.ts`, `db.ts` (service-role Supabase), `__tests__/`.
- **`api/edge/`** — `og-metadata`, `artist-page-static`, `release-page`, `noscript-search`, `u-handle`, `static-page-meta`. **`api/search/`** — only `bandcamp-probe.ts` and `enrichment.ts` are live; **`api/embed/`** is dead too (see below). **`api/shared/`** — code both Node and Deno (or Node and the web client) import, e.g. `platform-registry.ts`, `bandcamp-identity.ts`, `artist-bio.ts`, `crawler-detection.ts`, `release-display.ts`, `desktop-release.ts`. **`api/lib/`** — `resend.ts`, `sentry.ts`, `reserved-handles.ts`, `excluded-artists.ts`, `non-artist-names.ts`, `html.ts`.
- **`apps/web/`** — the SPA: `src/services/sources.ts` is platform config + search client, `src/contexts/AuthContext` holds auth and saved artists, `public/` carries the generated `sitemap.xml` / `dispatch.xml`, `tests/` is `unit/` + `integration/` + `fixtures/`.
- **`apps/web/server/`** — dev-only API served by Vite, **not production**. See "Local dev".
- **`apps/mac/`** — universal Apple app (macOS menu bar + iOS), SwiftUI. **`project.yml` is the XcodeGen definition and the source of truth for targets — edit it, not the `.xcodeproj`.** **`apps/extension/`** — MV3 extension, one content script per streaming site, two manifests.
- **`data/`** — `artist-list.json` (the Wikidata list), `artists/` (~790 pre-generated SEO JSON) + `artists-manifest.json` (feeds sitemap and social posts), `dispatch/` (archive), `social-posts/`, `shipped-features.json` (served to `/changelog`); **`scripts/`** generates all of it plus the feeds and sitemap.
- **`supabase/`** — `migrations/` is the schema (see "Database / migrations"). **`docs/`** — `engineering-history.md`, `specs/`, `postmortems/`, `openapi.yaml`. **`netlify.toml`** — edge routes, `/api/*` redirects, headers/CSP.

## Commands

```bash
npm run dev        # Full stack: netlify dev :8888 — real functions, edge functions,
                   #   production Supabase data + auth. Use this by default.
npm run dev:fast   # Vite only :5173 (no functions, no auth). CSS/layout only.
npm run verify     # THE CI GATE: typecheck + API + web unit tests (~45s)
npm run build      # Full build (see below) · npm run preview · npm run lint (advisory)

npm run test       # web + API · test:web · test:unit (CI) · test:api (CI) · test:watch
npm run test:integration   # live-API search accuracy; separate, not in CI
npm run typecheck          # root + apps/web (CI and build)
npm run typecheck:api      # api/ — listed files only, see below

npm run generate:artists|generate:data|generate:social   # Wikidata list, artist JSON, posts
npm run sync:bandcamp-dates · backfill:artist-rows · backfill:locations
npm run dedupe:releases            # Apply dedup rules to the stored catalog (see below)
npm run catalog:artist -- <slug>   # Catalogue pass for one artist
npm run ingest:try -- <artist>     # Dry-run Bandcamp ingest (see below); ingest:mirlo too
npm run preview:release -- <bandcamp-slug-or-url>  # Release-page harness :8788 (see below)
npm run sentry:sourcemaps · package:extension
npm run migrate:link|migrate:dry-run|migrate:list        # Supabase CLI, --linked
```

`npm run build` runs, in order: dispatch feed → changelog feed → sitemap → root `tsc -b` → `apps/web` `tsc -b` → `vite build`. Any failure blocks the deploy, so a type error can't ship.

**Every generator must run before `vite build`, and that ordering is load-bearing.** `vite build` fills the published `apps/web/dist` by copying `apps/web/public/`, so anything written there afterwards is never published. Put new generators **before** `cd apps/web`, and verify against the deployed artifact — the log prints success either way. (This shipped a frozen sitemap for four weeks.)

**The test suites are not part of the build** — they run in GitHub Actions (`ci.yml`), because Actions minutes are free here and Netlify builds are not. So **run `npm run verify` before considering work done**, and note that **a red CI run does not stop a deploy**: Netlify builds whatever lands on `main`, which is not branch-protected.

**Typecheck coverage gotcha:** `api/tsconfig.json` checks only the files its `include` lists, plus whatever they import. The list has grown to ~40 functions (search, `artist-profile`, claim and admin-verify, release detail and feeds, most `me-*`, collections, analytics, `social-card`), so most of the backend is covered — but not all of it. Edge functions and any unlisted function (e.g. `me-location`, `user-sharing`, `artist-releases`, `check-releases`, `admin-merge-override`) fail at runtime in production rather than in the build. Before trusting a green typecheck, check the file is listed; when it isn't, add it and fix what strict mode surfaces, or lean on its function tests.

## Key patterns

### Search flow

Two-phase.

- **Phase 1** — `GET /api/search/sources` → `search-sources.ts`. Fans out across platforms in parallel (~1-2s), aggregates, disambiguates, returns results. Applies MusicBrainz enrichment server-side when it has it; `hasPendingEnrichment` tells the client whether Phase 2 is still needed.
- **Phase 2** — `GET /api/search/musicbrainz` → `search-musicbrainz.ts`. Official sites, socials, location, release verification, Qobuz links. Merged client-side by `mergeWithMusicBrainzData` in `apps/web/src/services/sources.ts`.

**Both phases share one MusicBrainz enrichment and one cache entry** (`musicbrainz-enrichment.ts`, key `mb-enriched`, kept a day — not longer, since "no such artist" is cached too and new artists join MusicBrainz constantly). On a miss it is the slowest leg of a search by far, so a client sends `enrichment=deferred` and Phase 1 only *reads* that cache, never fetches: on a miss it returns without MusicBrainz and Phase 2 fills the cache for the next search. **Only the web client's single-artist search sends `enrichment=deferred`**; every other caller gets Phase 1 waiting on MusicBrainz inline, and don't make deferral the default. Of those, the v1 API, Discord bot, edge pages and the web client's multi-artist split never call Phase 2 at all. The Mac app and extension call it only when `hasPendingEnrichment` comes back true, and `scripts/generate-artist-data.ts` calls it every time and merges the result itself. Each Phase 1 logs a `[search-timing]` line and sends a `Server-Timing` header with per-phase durations; read those before guessing where a slow search went.

**Artists we already hold are shown first.** The web client calls `GET /api/search/stored` (`search-stored.ts`, database reads only) alongside Phase 1 and renders those claimed and verified cards while the fan-out runs. Both endpoints build them with `findStoredArtists` (`stored-artists.ts`), so the early cards carry the same ids as the full results' and are updated in place under `key={result.id}`. Keep it that way: `ResultCard` records a search appearance on a claimed artist's dashboard each time one *mounts*, so an id that differs between the two would count every search twice.

**Same name, different Bandcamp account = different artist.** Wherever two results meet by name — MusicBrainz enrichment on the server (`applyEnrichmentToResults`) and in the browser (`mergeWithMusicBrainzData`), and stored artists folded into live results (`mergeStoredArtistsIntoResults`) — a Bandcamp subdomain on both sides that differs means they stay separate cards (`bandcampSubdomainConflicts`, `api/shared/bandcamp-identity.ts`, shared by Node and the web client). The extension (`apps/extension/lib/bandcamp-identity.js`) and the Mac app (`UnstreamAPI.swift`) keep copies for their own Phase 2 merges; `bandcamp-identity-copies.test.ts` and `BandcampIdentityTests.swift` pin them to the same cases, so change all three together. `generate-artist-data` does its own Phase 2 merge too, and needs the same check. Honeycrush (Brooklyn) / Honey Crush (Orlando) is the standing example; deferring MusicBrainz to Phase 2 once reintroduced it because the browser merge lacked the check.

Multi-artist queries ("Artist feat. Artist2") are split, searched in parallel, then merged and deduplicated — by the web client only (`parseMultiArtistQuery` / `mergeSearchResponses` in `sources.ts`); the server, v1 and the apps never split.

`search-sources.ts` holds orchestration and per-platform fetchers, and is already large. `search-utils.ts` holds the pure helpers (`aggregateResults`, `splitSuspiciousPlatforms`, `mergeByReleaseOverlap`, `filterAndSort`, `applyMergeOverrides`) and `search-parsers.ts` the per-platform parsers. **Prefer adding logic there with a test over growing `search-sources.ts`.**

### Bandcamp discovery by subdomain probing

`bandcamp.com/search` is behind a Fastly bot challenge and `Disallow`ed in robots.txt, so it cannot be used. `api/search/bandcamp-probe.ts` derives candidate slugs from the query and requests `<slug>.bandcamp.com/music` (robots-permitted), resolving identity (`data-band`), release counts, location, titles and photo in one request per candidate.

**Verify both identity and substance.** A slug existing doesn't mean it's the right artist; a name matching doesn't mean it's a real presence — parked, empty accounts match `beyonce`, `sufjan`, `jackwhite`. Verdicts: `accepted`, `absent`, `rejected_empty`, `rejected_name`, `undecided`.

**The probe can only find a subdomain derived from the name.** An account like `honeycrush-online` (Honeycrush, Brooklyn) is reachable only through a link: MusicBrainz's Bandcamp relation, or — when that is missing or retired — a Bandcamp link on the artist's own official site or Linktree, accepted only if the subdomain carries the artist's name (`pickArtistBandcampUrl`) and isn't retired.

Outcomes — **including negatives** — are cached in `bandcamp_slug_probes` (migrations `20260726120000`–`20260726220000`, `20260727090000_bandcamp-probe-probed-slugs.sql`, `20260727120000_bandcamp-probe-clear-false-empty.sql`, `20260930120000_bandcamp-probe-bio.sql`). The `probed_slugs` column records which slugs were actually tried, so a cached negative can't hide an artist whose name has a hyphen.

### Never cache uncertainty

The lesson behind a run of bug fixes (#317–#328); it applies to every cached lookup.

- Distinguish **"the upstream answered with nothing"** (cacheable) from **"the upstream didn't answer"** — timeout, network error, bot challenge, 5xx (never cacheable as a negative). The probe's `undecided` verdict exists so the cache can refuse it.
- `cacheGetOrFetch` (`api/functions/cache.ts`) takes a `shouldCache` predicate and an optional short `failureTtlSeconds`. Use them for anything whose failure mode looks like an empty result.
- Cache keys must not collide across inputs that behave differently — `query_norm` strips punctuation, but punctuation generates extra slug candidates, hence `probed_slugs`.
- A silent `200` with an empty parse is a failure. Report it to Sentry rather than letting it look like "this artist doesn't exist."

### Redis is metered — count round trips, not just correctness

Upstash's free tier is **500,000 commands a month** (~16,600/day) — a *command* budget — and the site exhausted it in August 2026 at low traffic. One user search costs ~10 API requests, so any per-request Redis overhead is multiplied by ten. Four rules:

- **Every extra limiter has to earn its round trip.** Of `checkRateLimit`'s tiers, only `strict` (10/min) adds a daily quota — it fronts search (both phases draw on it, so a deferred web search spends two tokens), and its 500/day is a documented promise to anonymous v1 callers (`docs/openapi.yaml`). `standard`, `lenient`, `account` keep per-minute windows only (30/120/60). API-key tiers in `checkApiRateLimit` have their own minute and daily quotas (free 30/min + 100/day, pro 100/min + 10,000/day, internal 300/min).
- **Batch reads that share a request.** `cachePrefetch` reads the fan-out's per-platform keys in one `MGET` and passes each fetcher its value via `cacheGetOrFetch`'s `prefetched` argument; fetchers keep their own TTLs, predicates and write-backs. Add new cached platforms to that key list in `searchAllPlatforms` rather than issuing a separate `GET`.
- **Never spend two commands answering one question.** `checkSentryDedup` is a single `SET ... NX EX`. Prefer `SET NX`, `INCR`, `MGET` over read-then-write pairs.
- **Don't cache a constant** — only a real fetch is worth protecting.

`getMergeOverrides` / `getLinkSuppressions` are the one sanctioned in-process memo (global, tiny, read on every search): 60 seconds in `db.ts` on top of Redis, short enough that `invalidateAdminListCache` keeps its meaning. Don't generalise it.

### Testing release ingest locally

Cataloging only runs where `RELEASE_CATALOG_ENABLED=true`, set for the **Production context only**. Previews and local runs both point at **production** Supabase, so **setting the flag locally is not a valid workaround** — it would have your laptop writing production data and spending the real crawl budget. Use `npm run ingest:try -- <artist>` instead (`--json` for full row shapes, `--detail=3` for dates, formats and prices): it exercises the real fetcher, allowlist check, parser and mapping without touching the database. One Bandcamp request per run, plus one per release page with `--detail`; don't loop it.

There is deliberately no `--write`; to test the write path, point `SUPABASE_URL` at a branch database on purpose. And **don't reach for `CONTEXT` or `DEPLOY_PRIME_URL` in a function** — Netlify exposes only `URL`, `SITE_NAME` and `SITE_ID` at runtime, so an earlier `CONTEXT === 'production'` gate silently disabled cataloging entirely.

### Seeing the release page locally

`npm run dev` renders `/a/{artist}/{release}` through the real `api/edge/release-page.ts` and matches production; `dev:fast` runs no edge functions at all. The gap is data — production Supabase only holds a release once cataloging has run for that artist — so `npm run preview:release -- <bandcamp-slug-or-url>` (the *artist's* Bandcamp, then `http://localhost:8788`, which lists the discography) renders any release through the **real** edge function, fetching its Bandcamp page on demand. Only the database reads (artist, slug alias, release) are stubbed, so nothing can be written.

`release_catalog_state` is the observability surface (`last_attempted_at`, `releases_found`, `last_error`, `consecutive_failures`, `last_trigger`); `recordCatalogOutcome` reports a sudden drop to 0 releases to Sentry, since a parser break otherwise looks like an ordinary success.

### Keeping catalogues fresh

Catalog triggers are all demand-driven — a save, an artist's own button, the admin command, a collection import — and `check-releases` only *reads* the catalogue, so without a scheduled refresh an artist saved once is catalogued once and their alerts quietly stop. `api/functions/recatalog-sweep.ts` fixes that, run every twelve hours by `recatalog-sweep.yml` at 25 artists per run (50 a day).

**Search is deliberately not a trigger, directly or via the sweep** — queuing a crawl per Bandcamp-linked search result made an unauthenticated path the site's largest producer of database writes and exhausted the Supabase disk I/O budget; letting every searched artist into the sweep's pool did the same one step removed (the pool grew ~46 artists a day against the sweep's 50, so nearly every slot was a first-time crawl). Don't reintroduce either. The off-switch is the `RELEASE_CATALOG_ENABLED` env var — deleting it in Netlify stops cataloging with no deploy.

**The sweep's attention is demand-gated.** An artist gets a *first* catalogue only if they are saved by a fan, hold a verified claim, or appear in a connected Bandcamp collection — and since disk I/O round 6 (2026-09-19) the same three signals gate the *refresh* too: an artist already catalogued whom nobody follows is frozen rather than re-crawled (their `release_catalog_state` row stays, their page keeps showing the stored catalogue; prices go stale, the page does not empty). Everyone else with a crawlable link is counted as `awaitingDemand` (never catalogued) or `frozenCatalogues` (catalogued, frozen) in the sweep's log and left alone. Crawlable means **a real bandcamp, discogs, faircamp, jamcoop or mirlo link** (`CATALOGUEABLE_PLATFORMS` in `db.ts`) — `isCatalogueableLink` also excludes the `bandcamp.com/search?q=` placeholder links, which were once the only failures in `release_catalog_state`. **Keep that list identical to `catalogArtist`'s equivalent check** — an artist with only an official site is recorded as a *failure*, so sweeping them poisons `consecutive_failures`; the two change together (#415 added Mirlo to both). The sweep asks `requestArtistCatalog` for up to 25 under the `scheduled` trigger, but `claimArtistForCatalog` (7-day cooldown plus per-trigger hourly cap) is the authority, so running it twice is a no-op.

**The Bandcamp pass also repairs a deleted artist photo.** Search never writes to a claimed artist's row, so their `artists.image_url` stays what it was when they claimed, and Bandcamp deletes the old file when they change their photo. `refreshDeadArtistPhoto` (`artist-photo-refresh.ts`) replaces it with the `/music` page's `og:image`, but only when the stored photo answers 404 or 410, the page's band name matches the artist, the new photo is on Bandcamp's image host, and they haven't set their own `custom_image_url`. It only ever replaces a stored photo — an empty `image_url` is never filled — and the write is guarded on the old URL (`replaceArtistPhoto`), so a newer search result wins. It is the one write the pass makes to a claimed row, allowed because `image_url` was never the artist's choice, and it leaves `updated_at` alone.

**Paging, not `.limit()`.** PostgREST caps every response at 1,000 rows whatever limit you ask for, and truncates *silently* — a `.select()` over `artist_links` returns 1,000 of ~3,900 rows and looks successful. Use `readAllPages` (or `.range()` in a loop) for any read whose table can exceed 1,000 rows.

### Artist bios

A search or detection result carries one `bio` (`{ text, source, sourceUrl, truncated }`), picked **on the server** by `api/shared/artist-bio.ts` in this order: claimed profile → Bandcamp sidebar → Discogs profile → Wikipedia (via MusicBrainz's Wikidata relation). Clients only render it, as plain text, and label the source by platform (no source line at all for a claimed bio, whose card already links to the artist's page). Spec: `docs/specs/artist-bio-excerpt-spec.md`. Four rules:

- **`artist_profiles.show_bio = false` means no bio at all**, not a fallback. It shows up on the card as `bioSuppressed`, and clients never fill a claimed card from Phase 2.
- **Phase 2 fills a gap, never replaces.** Phase 1's sources outrank Phase 2's, and a fill requires an exact name match.
- **`bandcamp_slug_probes.bio`: `''` means checked-and-empty, `NULL` means never checked.** Keep the two distinct.
- **A bio source that didn't answer is not "no bio".** `bioFetchFailed` keeps that result out of the long cache.

### Platform registry

`api/shared/platform-registry.ts` is the single source of truth for platform metadata: name, color, icon, category (marketplace, patronage, decentralized, library, official, social), payout percentage, AI policy, `CATEGORY_ORDER`. Add or change platforms there rather than hardcoding elsewhere, then check for stale copies:

```bash
grep -r "PLATFORM_INFO" api/edge/ apps/web/src/
```

`apps/web/src/services/sources.ts` mirrors the registry by hand (it isn't derived from it, and has drifted before) and adds client-only fields (description, `searchUrlTemplate`, `hasEmbed`, `searchOnly`). Keep the shared fields in sync. That grep doesn't find the other hand-kept tables, which need the same change: the extension's `apps/extension/lib/constants.js`, the Mac app's `Models/PlatformCatalog.swift`, and `api/functions/platforms-list.ts` (behind `/api/v1/platforms`).

### Local dev: the full stack, and the fast shim

**Use `npm run dev` — the real one — by default.** It is the *only* way to exercise the real backend before merging, because Deploy Previews are opt-in per push (see Deployment); treat a gap in it as a real gap.

| | `npm run dev` (`netlify dev`, :8888) | `npm run dev:fast` (Vite, :5173) |
|---|---|---|
| Netlify functions (`api/functions/`) | **real** | not run — `apps/web/server/` shim |
| Edge functions (`api/edge/`) | **real** | not run at all |
| `netlify.toml` redirects, headers, routing | **applied** | ignored |
| Supabase data | **production** | none |
| Auth (sign-in, sessions, admin) | **works** | dead — "Auth not configured" |
| `/data/**` (changelog) | served | 404s as the SPA shell |
| Boot | ~15s | ~1s |

`dev:fast` is for pure CSS/layout iteration. Anything touching data, auth, an API response, SEO markup or routing needs `npm run dev`.

**It reads and writes PRODUCTION Supabase.** `netlify dev` injects the live site's environment, so functions hold `SUPABASE_SERVICE_KEY` and bypass RLS as production does. Reads are free; **writes are real** — saving an artist, claiming a profile or changing settings mutates production rows, and `RESEND_API_KEY` / `BUTTONDOWN_API_KEY` mean notification paths can send real email. Cataloguing is the one thing that stays off; don't "fix" that.

Four traps, all producing a *silently wrong* result rather than an error:

- **The empty-value shadow.** A key present but blank in `.env` overrides the real value from the Netlify site settings, logged as `Ignored project settings env var: X`. **Delete a key from `.env` rather than leaving it blank**, and check the startup log's `Injected project settings env vars` list — a key you need belongs there, not in an `Ignored` line. Three blank keys are why local auth never worked until 2026-08-15.
- **The stale port.** `dev:fast` passes `--strictPort` on purpose; the `[dev]` block in `netlify.toml` says why removing it lets another checkout's leftover server answer everything.
- **The shim is not the backend.** Only `dev:fast` uses `apps/web/server/`, whose search implementation has drifted. Editing `search-sources.ts` does not change what `dev:fast` returns; editing `apps/web/server/*` does not change production. Concretely, the shim's `/api/suggest` returns a hardcoded empty list where `npm run dev` returns real `artists` rows.
- **A worktree serves the main checkout's functions.** Worktrees under `.claude/worktrees/` sit inside the main repo, and netlify-cli finds its root by looking for a `.git` *directory* — a worktree's is a file — so `npm run dev` there builds `api/functions/` from the main checkout. A new function answers `Function not found...`; an edited one quietly runs the old code. Pass the worktree's own folder: `npm run dev -- --functions "$PWD/api/functions"`, and check that `.netlify/functions-serve/<name>/<name>.js` requires `./api/functions/…`, not an absolute path into the main checkout. Edge functions still come from the main checkout and there's no flag to move them, so edge work needs the main checkout (or, for the release page, `preview:release`). A worktree also needs `.netlify/state.json` and `.env` copied from the main checkout (both gitignored).

`npm run dev` rewrites `deno.lock`; `git checkout -- deno.lock` before committing, same habit as the generated feed XML.

### Dead code in `api/search/` and `api/embed/`

`api/search/sources.ts`, `bandcamp.ts`, `site-search.ts` and `musicbrainz.ts`, and `api/embed/bandcamp.ts`, are Vercel-era leftovers (they import `@vercel/node`, which isn't even a dependency) and are imported by nothing — only `bandcamp-probe.ts` and `enrichment.ts` in `api/search/` are live, and `/api/embed/bandcamp` is served by `api/functions/embed-bandcamp.ts`. Editing the dead files is a classic wasted-session trap: the change deploys and nothing happens. Verified in `docs/specs/bandcamp-coverage-research.md` §1.

### Feature surfaces

- **Artist profiles.** Artists claim via `/claim/:slug`: sign in by magic link (or arrive signed in), then prove ownership by linking a verify URL from the artist's own website, with manual review as the fallback. The wizard is split across `Claim*Step.tsx` (steps in `ClaimPageTypes.ts`). Claimed profiles are edited at `/artist-edit/:slug`, with release curation at `/artist-edit/:slug/releases` (`artist-releases.ts`). Artist pages (`/a/:slug`, `/artist/:slug`) are SPA pages for people; the `artist-page-static` edge function serves crawlers only (see "Edge functions").
- **Dashboard.** `/dashboard` is one page for fans and artists: claimed artists with their analytics (searches, views, clicks), saved artists, the Bandcamp collection, and upcoming/recent releases (`me-recent-releases.ts`). The old `/artist-dashboard` and `/artist-login` routes redirect.
- **Saved & supported artists.** Signed-in fans save artists and mark them supported (migrations 013–018), synced to the Apple app via `saved-artists-sync.ts` with tombstones and scheduled GC. A claimed public username (migration 021) plus a sharing opt-in (022) gives a public list at `/u/:handle` (`PublicSavedArtistsPage` for people, the `u-handle` edge function for crawlers), backed by `public-saved-artists.ts`; reserved handles live in `api/lib/reserved-handles.ts`.
- **Release alerts and feeds.** `check-releases.ts` reads the catalogue and `notifications.ts` emails fans about new releases and new platform links (plus claim approved/rejected mail), with `email_log` as the "already sent" guard; preferences are `me-notifications.ts` (`/api/me/notification-preferences`). `feed-releases.ts` serves calendar and RSS feeds: private ones at `/feed/f/{token}.ics|.xml` (token from `me-feed-token.ts`) and public ones at `/u/:handle/releases.*` and `/a/:artist/releases.*`. `weekly-analytics-recap.ts` (artist recap email) is **paused** — no schedule, toggle hidden; its workflow header says how to restore it.
- **Bandcamp collection.** `/settings` connects a fan's Bandcamp account through `me-bandcamp.ts`, which stores encrypted Subsonic credentials (`credential-crypto.ts`); `bandcamp-sync-background.ts` imports, `me-collection.ts` hides items, `collection-art.ts` proxies cover art at `/api/collection/art/*`. Matching is under "Collections" below.
- **Listening signals.** `me-listening.ts` takes the Mac app's Apple Music library scan into `listening_signals` and serves the private "gap report" (artists you play a lot and have never paid).
- **Account settings.** `/settings` is backed by the `me-*` functions (`me-settings`, `me-username`, `me-location`, `me-password`, `me-notifications`, `me-bandcamp`, `me-feed-token`) plus `user-sharing.ts`. Each should have a test in `api/functions/__tests__/` (`me-feed-token` doesn't yet) and be listed in `api/tsconfig.json`'s include (`me-location` and `user-sharing` aren't yet) — **follow that pattern for new account endpoints.**
- **Patronage (not built yet).** `20260930170000_artist-tips.sql` created `artist_tip_accounts`, `tip_payments`, `artist_goals` and `support_entries` in production, but no code on `main` reads them yet. They aren't orphans; don't drop them.
- **Public API (v1).** Documented in `docs/openapi.yaml`, surfaced on `/developers`, routed in `netlify.toml`: `/api/v1/search`, `/artist/*`, `/resolve`, `/platforms`, `/status`, `/keys`. Keys are stored hashed (migration 007); key-bearing requests get permissive CORS, anonymous ones are restricted to `unstream.stream`.
- **Discord bot.** `discord-interaction.ts` verifies signatures (tweetnacl) and dispatches to `discord-search-background.ts`; commands are registered with `scripts/discord-register-commands.ts`.
- **Platforms and FAQ, not guides.** The guides section was retired on 2026-09-27: SEO pieces that drew no traffic and weren't in Brandon's voice. What was documentation became `/platforms` (generated from `sources.ts`, so it can't drift from the registry) and FAQ entries in `apps/web/src/data/faq.ts` (mirrored by hand in `apps/web/public/faq.txt`). Old `/guides/*` URLs are 301s in `netlify.toml`; `/guides.xml` is a frozen copy in `apps/web/public/`. Don't bring back long-form content here; Brandon's writing lives in his newsletter.
- **Newsletter.** Unstream has no newsletter of its own. Updates go out in Brandon's newsletter, Lightbulbs On (Buttondown), and every signup names it (`apps/web/src/data/newsletter.ts`). Signups go through `newsletter-subscribe.ts` (double opt-in), from the inline forms, an unticked checkbox on the claim flow, and a one-time dashboard prompt, which a new account sees under `WelcomeBanner`. **Not on `/login`**: it is sign-up and sign-in at once, and telling them apart before auth would leak which emails have accounts. The source becomes a Buttondown tag: the inline forms tag their page (`changelog`, `contact`, `platforms`), the claim checkbox `artist`, the dashboard prompt `unstream`.
- **Admin tools.** Admins (the `ADMIN_EMAIL` env var on the server) merge duplicate results at `/admin/merge`, review verification and merge duplicate artist rows at `/admin/verify`, suppress a single wrong link at `/admin/links`, work the tier-3 dedup queue at `/admin/release-review`, and view `/admin/analytics`. Merge overrides live in Supabase (migrations 004–005), are respected during disambiguation, and can be managed with `npx tsx scripts/merge-override.ts`.
- **Smaller pieces.** `/api/suggest` typeahead (`search-suggest.ts`, reads `artists`); the embeddable widget (`apps/web/public/widget.js`); `/api/embed/bandcamp` (`embed-bandcamp.ts`); `purge-cache.ts` (CDN tag purge after a claimed artist edits). Other SPA pages: `/artists` directory, `/known-artists`, `/import`, `/support` (`/plus` 301s there), `/changelog`, `/roadmap`, `/press`, `/contact`, `/extension`, `/developers`.

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

A Bandcamp import (`bandcamp-sync-background.ts`) writes a `collection_items` row per album and attaches a release only when one already exists, so most of a real collection arrives unlinked — the fan bought from artists nobody has ever searched.

**There is no source URL to fall back to.** Bandcamp's Subsonic API returns `id`, `name`, `artist`, `coverArt`, `year`, `genre`, `created` and nothing else, so "just link to Bandcamp" isn't available and deriving `<artist>.bandcamp.com/album/<title>` mints 404s. Don't reach for it.

`collection-matching.ts` closes the gap in two halves: `resolveCollectionArtists(userId)` at the end of a sync, on **both** the success and failure paths (it touches neither the Subsonic API nor the credential, so a Subsonic 500 must not block discovery), and `linkCollectionItemsForArtist` at the end of every catalogue pass, attaching releases to waiting items forever after.

Matching is exact on `releases.match_key` via `releaseMatchKey`, the function that produced the column. **Use that one, never `normalizeForComparison`**: it strips to `[a-z0-9]`, so a title with no Latin characters normalizes to empty and can never match. A near-miss stays unlinked on purpose — a collection page asserts a specific person bought a specific record.

### Mac app updates (Sparkle)

The Mac app ships as a direct GitHub release and updates itself with Sparkle 2 (SPM, filtered to macOS in `project.yml`). `api/shared/desktop-release.ts` is the single source of truth for the current release; `desktop-appcast.ts` renders it at `/appcast.xml`, and the legacy `/api/desktop/version` endpoint reads the same constant for installs older than 3.6.0. Two traps — detail in `apps/mac/docs/sparkle-updates.md`:

- **Sparkle compares `CFBundleVersion`, not the marketing version.** An appcast whose `sparkle:version` is `3.6.0` against an installed `CFBundleVersion` of `15` offers no update. Bump the build number on every release.
- **The sandbox needs three things at once**: `SUEnableInstallerLauncherService` in `Info-macOS.plist`, the `-spks`/`-spki` `mach-lookup` entitlement exceptions, and the app staying sandboxed. Break one and updates download fine then fail to install — which reads as success right up to the last step. The Developer ID `archive` + `-exportArchive` path also re-signs Sparkle's XPC helpers; don't hand-roll `codesign --deep`.

### Edge functions (SSR/SEO)

Routed in `netlify.toml`: `/` → `og-metadata`; `/a/{artist}/{release}` → `release-page` (a regex entry, which must stay above `/a/*`); `/artist/*` and `/a/*` → `artist-page-static`; `/search` → `noscript-search`; `/u/*` → `u-handle`; `/press`, `/contact`, `/platforms` → `static-page-meta` (link previews only). `/a/*/releases.{ics,xml}` and `/u/*/releases.{ics,xml}` are excluded from the edge routes and go to the `feed-releases` function.

**Who gets which renderer.** `release-page` is pure SSR for everyone. `artist-page-static` and `u-handle` render only for crawlers (`api/shared/crawler-detection.ts`) and hand real browsers to the SPA before any database query, so a direct load and an in-app click produce the same UI.

`/artists` is SPA-only after UNS-98; `artist-directory-page` was removed. Edge functions run on Deno and import from URLs (`edge.netlify.com`, `esm.sh`) — they can't import from `api/functions/`, so shared constants get duplicated or pulled from `api/shared/`.

### Social posts

`schedule-social-posts.yml` runs `scripts/generate-social-posts.ts` every Monday, scheduling the following week to Buffer. The copy lives in `scripts/social-post-templates.ts` (pure, tested in `apps/web/tests/unit/`); the generator picks artists, reads each verified artist's links and release catalogue from the public `/api/artist-page` (the Action has no Supabase secrets, and `/api/artist-releases` is owner-only), and talks to Buffer. Each day's Threads and Bluesky posts go out as one Buffer **content item** (`createContentItem`, an early-preview API); single posts use `createPost`. On indie days the Instagram post is created on its own and then added to that item (`addPostToContentItem`): a content item is all-or-nothing, and its failure payload doesn't say whether the other variants were created, so a rejected Instagram variant inside it would cost the Threads post too and couldn't safely be retried. Every post and content item carries one `unstream: …` Buffer tag for its kind (`TAGS` in the generator, created on first use), so Buffer's analytics can compare them. The rules, measured in `docs/engineering-history.md`:

- **Spotlights are written for the artist to repost**, because reposts by indie artists are the only distribution that has worked. Prominent artists get one post a week, untagged.
- **Tag on Threads only with a handle from the artist's own Threads link.** An Instagram handle that Threads can't resolve is published with its @ stripped.
- **Payouts come from `platform-registry.ts`**, never a local table; the purchase math uses the low end of a range.
- **A prominent artist's Bandcamp link counts only if the subdomain is their name** (`bandcampMatchesArtist`). The generated artist files matched those links by name, and 159 of 791 are someone else's page ("venomnoise" for Venom).
- **Instagram gets indie spotlights only, as cards Unstream draws** — never a press photo on its own, which Instagram stopped recommending (`docs/specs/instagram-original-posts-spec.md`). `/api/social-card/{slug}/{slide}.png` (`api/functions/social-card.ts`) draws each slide from the artist's data on request, for claimed artists only; the platform and release travel in the URL so the card matches the caption Buffer publishes days later. The generator fetches every card before scheduling and drops any that don't render. At most three hashtags, never `#newmusic` or `#newrelease`; the artist is tagged on the first card only from their own Instagram link. Instagram posts before `INSTAGRAM_DRAFTS_BEFORE` go to Buffer as drafts.
- **An artist's stored photo is checked before a post carries it** (`livePhotoUrl`, `scripts/social-post-photos.ts`), because Buffer fetches it on publish day and a missing one fails the post. Only a 404 or 410 drops it. A timeout, a 5xx or a generic content type (Mirlo serves WebP as `application/octet-stream`) keeps it. 12 of 139 verified artists' photos had gone stale by October 2026. The catalogue pass now repairs those (see "Keeping catalogues fresh"), but a photo can still be deleted between passes.
- **The renderer is a Netlify Function, not an edge function**, because edge functions get 50ms of CPU and a photo slide takes ~130ms. It's bundled as CommonJS despite `"type": "module"`, so it finds its fonts and wasm through `__dirname`/`require`; `import.meta` is empty there.
- The LinkedIn page gets two posts a week; Brandon's personal LinkedIn is never posted to.

### The Dispatch

A weekly music-industry briefing. **The workflow changed on 2026-04-17:** it is delivered to the `#unstream-dispatch` Discord channel by a scheduled agent, and RSS publishing was retired — nothing new is written to `data/dispatch/`. What remains is the archive plus `scripts/generate-dispatch-feed.ts`, which still runs at build time so `/dispatch.xml` renders the historical feed.

The old "commit dispatch work directly to `main`" instruction is dead — do not follow it.

### Industry digest

A separate, unlisted weekly digest for Brandon: `industry-digest.yml` runs `scripts/industry-digest/` every Friday, an Ollama cloud model compiles it, and it is published as `feed.xml` on the **`industry-digest` branch** — never `main`, never `apps/web/public/`, so a new issue costs no deploy. `api/functions/digest-feed.ts` relays that file at **`/digest/feed.xml`** (noindexed, CDN-cached for an hour, linked from nothing). The model cites numbered stories and never writes a URL; keep it that way. Detail in `scripts/industry-digest/README.md`.

The script itself sits outside `ALLOWED_OUTBOUND_HOSTNAMES`: that allowlist guards the site's functions, and the script fetches only the fixed feeds in `sources.ts` and `ollama.com`. `digest-feed.ts` is a function, so its one host (`raw.githubusercontent.com`) is on the list.

### API middleware & security

`api/functions/middleware.ts` centralizes CORS (`buildCorsHeaders` / `buildPublicCorsHeaders`), auth (`authenticateBearer`, `authenticateBearerFast`, `authenticateAdmin`, `authenticateApiKey`, `isInternalRequest`), query validation (`validateQuery`), v1 envelopes (`v1Response`), and SSRF protection.

**CORS has two shapes.** `buildCorsHeaders` (v1, admin, account endpoints) restricts anonymous callers to `https://unstream.stream` and opens up for API-key requests. `buildPublicCorsHeaders` (`search-stored`, `search-suggest`, `platforms-list`, `api-status`) and the search endpoints send `Access-Control-Allow-Origin: *`.

SSRF protection starts with an **explicit hostname allowlist** — `ALLOWED_OUTBOUND_HOSTNAMES` + `isUrlHostnameAllowed()`. Every outbound fetch must pass it, and a new platform fetch means adding its hostname (wildcards like `*.bandcamp.com` work). It also blocks non-HTTP(S) schemes, localhost and private and metadata IPs. Its comments record *why* hosts were removed (e.g. no `qobuz.com`: robots-disallowed, links come from MusicBrainz relations and are displayed but never fetched) — preserve that reasoning when editing. **A hostname check alone is not an SSRF boundary**: any URL that came from a request, a database row or scraped markup goes through `safeFetch` (`api/functions/safe-fetch.ts`), which follows redirects by hand, re-validates every hop, and requires every resolved IP to be public (`169-254-169-254.nip.io` passes a string check). `check-releases`, `catalog-artist-background` and `artist-photo-refresh` use it.

Rate limits and Sentry dedup live in `ratelimit.ts` (`checkRateLimit`, `checkApiRateLimit`, `checkSentryDedup`).

## Auth

Supabase Auth with magic links and password sign-in. Auth state is managed via `AuthContext` (`apps/web/src/contexts/`), which also holds saved artists. RLS policies protect all database tables — add/adjust policies in a migration when introducing new tables or columns.

On the server:

- **Account endpoints** (`me-*`, `saved-artists`, `saved-artists-sync`, `user-sharing`) authenticate and rate-limit through `resolveAccountRequest` (`ratelimit.ts`), which verifies the JWT locally (`authenticateBearerFast`) — a revoked session keeps working for up to an hour (#331).
- **Where a fresh check matters, make the round trip to Supabase:** `authenticateBearer` (admin via `authenticateAdmin`, API-key issuance, `artist-releases`). `me-password` is the one account endpoint outside `resolveAccountRequest`; it calls `getUser` itself because it needs the access token.
- **Admin** is the `ADMIN_EMAIL` env var on the server; `AuthContext` hardcodes the same address only to show admin UI.
- **Function-to-function calls** (background jobs, the sweep) carry `INTERNAL_FUNCTION_SECRET`, checked by `isInternalRequest`.

## Database / migrations

The schema is the migrations: timestamp-prefixed files in `supabase/migrations/`, starting from `20260331000000_baseline.sql`. (`supabase/schema.sql` is a stale early snapshot — 4 tables, last touched August 2026 — kept for reference only; don't read it as current.) Changes ship as new files there (e.g. `20260726120000_bandcamp-slug-probes.sql`), and **filename order is what Supabase applies**. The sequential `-- Migration NNN` header comments and the older `migration-NNN-*.sql` copies are historical reference only — the sequence has gaps. Don't edit historical migrations.

When adding a table or column: new migration, RLS policies included, `IF NOT EXISTS` / `DROP ... IF EXISTS` guards for idempotency, comments explaining the change. Server-only tables (like `bandcamp_slug_probes`) enable RLS with *no* policies — the service-role client bypasses RLS, anon gets nothing — and should say so in a comment so the missing policies don't read as an oversight.

**Auto-deploy:** `supabase-migrate.yml` runs `supabase db push --linked` on every push to `main` touching `supabase/migrations/`. Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.

**Applying a migration to production from an unmerged branch poisons every later migration.** `supabase db push` aborts *before applying anything* when production has a version missing locally, so one migration left on an unmerged branch silently blocks everybody's migrations on `main` — it happened, and took release alerts down for 30 hours. If you run the workflow by hand from a branch, merge it promptly and **check the workflow went green**; the failure is loud in Actions and invisible everywhere else.

**Local dry-run:** `npm run migrate:link` once, then `npm run migrate:dry-run`. Both that and `migrate:list` use `--linked`; the CLI dropped `--project-ref`, and passing it prints a help blob and exits *without checking anything*, which reads like a clean run. If you see `Cannot find project ref`, run the link step. The dry run can't validate SQL — for that, run the migration against a throwaway Postgres in Docker.

## Testing

Vitest, in three places:

- `apps/web/tests/unit/` — component and pure-logic tests. Run in CI.
- `apps/web/tests/integration/` — search accuracy against live APIs (`tests/fixtures/expected-results.json`). Separate; not in CI.
- `api/functions/__tests__/` — function tests (cache behavior, probe cache coverage, XSS defense, the `me-*` endpoints). In CI via `npm run test:api`.

`npm run verify` runs the CI gate locally. `npm run lint` is *not* in it: ESLint reports ~67 pre-existing errors (mostly `any` and unused vars in `tests/unit/` and the `apps/web/server/` shim, plus ~15 in `src/`), so enforcing it would fail every PR for unrelated reasons — worth clearing separately, advisory until then.

The root `vitest.config.ts` covers both trees so `npx vitest` works from the repo root; `apps/web/vitest.config.ts` covers the web tree. Default environment is `node` — add `// @vitest-environment jsdom` atop a `.tsx` test needing a DOM. Both alias `src` → `apps/web/src`. The Apple app has XCTest coverage in `apps/mac/UnstreamTests/`, run by `mac-build.yml` on changes under `apps/mac/`.

## Deployment

Pushes to `main` trigger Netlify builds (`npm run build`). Functions deploy from `api/functions/`, edge functions from `api/edge/`; edge routes, `/api/*` redirects and headers/CSP live in `netlify.toml`.

**Not every push deploys.** `netlify.toml`'s `ignore` setting runs `scripts/netlify-ignore-build.sh`, which cancels the build when a push touches only paths Netlify never publishes — `apps/mac/`, `apps/extension/`, `supabase/`, `docs/`, `.github/`, `README.md`, `CLAUDE.md`. **Its exit code is inverted: 0 cancels, 1 builds**, and every branch defaults to deploying, because a skipped deploy leaves production silently stale. `data/` and `scripts/` are deliberately absent, since `data/` is copied into `dist/` and `scripts/` generates the manifests, feeds and sitemap — so if you add a path whose contents reach the built site, check it isn't shadowed.

**Deploy Previews are opt-in per push.** `[context.deploy-preview]` runs `scripts/netlify-ignore-preview.sh`, which cancels the preview unless the PR's head commit message contains `[preview]` — so by default a PR gets no preview URL and its Netlify checks don't run (configuration, not breakage). #451 turned them off because they ate the build allowance; add the marker only to the push you actually want to open on a phone or share. A preview runs the real functions against **production** Supabase, same as `npm run dev`. Without the marker, **`npm run dev` is the only way to exercise the real backend before merging.**

GitHub Actions: `ci.yml` (typecheck + both suites — the gate that used to live in the Netlify build) · `supabase-migrate.yml` · `schedule-social-posts.yml` (weekly, committed back) · `semantic-revert-check.yml` (runs `scripts/semantic-revert-check.py` to flag changes that quietly undo earlier fixes — take it seriously; bug loops in `docs/postmortems/UNS-100-bifurcation-retro.md`) · `upstash-keepalive.yml` · `recatalog-sweep.yml` (every 12h) · `mac-build.yml` (compiles the Apple app and runs XCTest on `apps/mac/` changes; never signs or uploads) · `industry-digest.yml` (Fridays) · `weekly-analytics-recap.yml` (paused, manual dispatch only).

## Engineering principles

Default to **simple, boring code that a human can read once and understand.** The owner reviews at the product level, so the codebase has to stay legible to whoever (human or agent) touches it next. When in doubt, choose the obvious option over the clever one.

- **Boring beats clever.** Plain, explicit code over abstraction, metaprogramming or "smart" one-liners. No layers, generics or config flags for flexibility nobody asked for.
- **Match the surrounding code.** Follow the naming, structure and idioms already in the file, and reuse existing helpers (`middleware.ts`, `cache.ts`, `platform-registry.ts`, `apps/web/src/services/*`) instead of reinventing them.
- **Small, focused units.** See how `ResultCard*` and `Claim*Step` are split, and how pure search logic moved to `search-utils.ts` / `search-parsers.ts`. If a file grows a second responsibility, split it.
- **Name things for what they do,** with a short comment for non-obvious *why*; don't comment the obvious. Comments explaining *why* an approach was abandoned (blocked endpoints, removed allowlist hosts, cache-collision fixes) are load-bearing — keep them current instead of deleting them.
- **No dead weight.** No commented-out code, unused exports, speculative branches or TODOs without follow-through.
- **Scale through clarity, not premature optimization.** Straightforward version first; optimize only with a concrete reason (a real hot path, a measured cost), and note the trade-off.
- **Fail loudly.** Validate inputs at boundaries, surface errors to Sentry, avoid silent catches. A scraper returning an empty array on a bot challenge is a silent failure: report it.
- **Never cache uncertainty.** A failed lookup is not a negative result — the most repeated bug class in this codebase.
- **One route, one renderer.** If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. "Two renderers for one URL" causes back-button / bfcache breakage and bug loops where every fix partially reverts the last (`docs/postmortems/UNS-100-bifurcation-retro.md`, UNS-70/71/73/94/97/99/100). When you need both crawler HTML *and* React interactivity, decide per request: the edge function renders for crawlers and hands real browsers straight to the SPA (`context.next()` before any data fetch), so each request gets exactly one renderer and the SPA never "takes over" from a static response. `/u/:handle` and the artist pages are the reference; the release page is the other legal shape, pure SSR for everyone with nothing hydrating.
- **Respect other people's servers.** Check `robots.txt` before adding a scrape and honor it — several outages here were self-inflicted by scraping disallowed paths. Prefer documented APIs, directories and sitemaps; cache aggressively.

### Security practices

Treat security as part of "done," not a later pass. Flag anything you can't fully resolve rather than leaving it silent.

- **Validate and sanitize all external input** at the boundary — query params, bodies, URL params, webhook payloads. Escape anything interpolated into edge-function HTML with `escapeHtml`. Each edge function keeps its own copy (Deno can't import from `api/functions/`), and `xss-defense.test.ts` tests a pasted copy rather than the edge code, so check every interpolation by eye and test the edge function's own render where you can.
- **SSRF protection is mandatory** for any code fetching an external URL. Add hosts to `ALLOWED_OUTBOUND_HOSTNAMES` and check with `isUrlHostnameAllowed()`; for a URL from a request, the database or scraped markup, use `safeFetch`. Never add a raw `fetch(userUrl)`.
- **Respect the CORS/auth model.** Account, admin and v1 endpoints use `buildCorsHeaders`: anonymous callers restricted to `unstream.stream`, API-key requests permissive because the key is the authorization. Only read-only public data gets `buildPublicCorsHeaders` (`*`). Use the shared middleware.
- **RLS on every table.** New tables/columns ship with policies in a migration. Server-only tables ship with RLS enabled, no policies, and a comment saying that's deliberate. Never rely on client-side checks for authorization.
- **`REVOKE ... FROM PUBLIC` is not enough for functions on Supabase.** Supabase's default privileges grant EXECUTE on every new `public` function *directly* to `anon` and `authenticated`, so a PUBLIC revoke still leaves both able to call it at `/rest/v1/rpc/<name>` — this left `rollup_app_events()` (which deletes rows) anon-callable for a few hours (found and fixed 2026-09-19 in `20260919140000_revoke-anon-function-execute.sql`). Revoke from `PUBLIC, anon, authenticated` and rely on the service role; every `rpc()` in the codebase runs through `getClient()` in `db.ts`. Vanilla-Postgres Docker validation cannot catch this class — only Supabase has those default privileges.
- **No secrets in code or logs.** Don't log API keys, tokens, magic-link codes or personal data. API keys are stored hashed — keep it that way. Cache keys derived from user input hold normalized search terms, not PII.
- **Verify signed requests** where the pattern exists (e.g. Discord signature verification with tweetnacl). Don't bypass it for convenience.
- **Keep CSP and security headers intact** — don't loosen them in `netlify.toml` without a clear reason.
- **Least privilege.** Check admin/ownership before privileged actions (merges, verification, profile edits, username claims) on the server, not just in the UI.

## Working with the project owner

The owner is a highly experienced product manager with deep familiarity with web technologies, product strategy, UX and the alternative music platform ecosystem. He gives detailed product requirements, evaluates trade-offs, reviews UI/UX and navigates the codebase conceptually. He is not a software, security or infrastructure engineer. So:

- **Write production-ready code directly** rather than snippets to implement. Don't assume he can fill gaps, wire things up or debug build/runtime errors himself.
- **Handle security proactively** — CSP, RLS, input validation, SSRF, auth edge cases. Flag issues clearly rather than expecting them to be caught in review.
- **Manage infrastructure** — Netlify config, migrations, edge routing, env vars, deploys — and explain what changed and why.
- **Explain trade-offs in product terms**: user impact, maintenance burden, complexity.
- **Run tests and lint before considering work done.** Don't leave broken builds for him to debug.
