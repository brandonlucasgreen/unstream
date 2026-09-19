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
- **Enrichment**: MusicBrainz, Wikidata, Wikipedia, Discogs, Linktree, Bandcamp artist pages. **Caching / rate limiting**: Upstash Redis. **Monitoring**: Sentry (`apps/web/src/services/sentry.ts`, `api/lib/sentry.ts`). **Analytics**: GoatCounter + custom Supabase analytics.
- **Integrations**: public REST API (v1), Discord bot, social post automation, ListenBrainz scrobbling.
- **Clients**: web app, universal Apple app (macOS menu bar + iOS, SwiftUI), browser extension (Chrome + Firefox, MV3). **Hosting**: Netlify.

## Repository structure

Only the non-obvious parts; `ls` covers the rest.

- **`api/functions/`** — Netlify serverless functions, **the live backend**: `search-sources.ts` (Phase 1 orchestration, the big one), `search-musicbrainz.ts` (Phase 2), `search-utils.ts` + `search-parsers.ts` (pure, unit-testable logic), `middleware.ts` (CORS, auth, validation, SSRF allowlist), `cache.ts`, `ratelimit.ts`, `db.ts` (service-role Supabase), `__tests__/`.
- **`api/edge/`** — `og-metadata`, `artist-page-static`, `release-page`, `guide-page`, `noscript-search`, `u-handle`. **`api/search/`** — only `bandcamp-probe.ts` and `enrichment.ts` are live (see below). **`api/shared/`** — `platform-registry.ts`, `bandcamp-friday.ts`, `release-display.ts`, `desktop-release.ts`.
- **`apps/web/`** — the SPA: `src/services/sources.ts` is platform config + search client, `src/contexts/AuthContext` holds auth and saved artists, `public/` carries the generated `sitemap.xml` / `dispatch.xml`, `tests/` is `unit/` + `integration/` + `fixtures/`.
- **`apps/web/server/`** — dev-only API served by Vite, **not production**. See "Local dev".
- **`apps/mac/`** — universal Apple app (macOS menu bar + iOS), SwiftUI. **`project.yml` is the XcodeGen definition and the source of truth for targets — edit it, not the `.xcodeproj`.** **`apps/extension/`** — MV3 extension, one content script per streaming site, two manifests.
- **`data/`** — `artists/` (~790 pre-generated SEO JSON) + `artists-manifest.json` (feeds sitemap and social posts), `guides/`, `dispatch/` (archive), `social-posts/`, `shipped-features.json` (served to `/changelog`); **`scripts/`** generates all of it plus the feeds and sitemap.
- **`docs/`** — `engineering-history.md`, `specs/`, `postmortems/`, `openapi.yaml`. **`netlify.toml`** — edge routes, `/api/*` redirects, headers/CSP.

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
npm run typecheck:api      # api/ only — narrow include, see below

npm run generate:artists|generate:data|generate:social   # Wikidata list, artist JSON, posts
npm run sync:bandcamp-dates · backfill:artist-rows · backfill:locations
npm run dedupe:releases            # Apply dedup rules to the stored catalog (see below)
npm run catalog:artist -- <slug>   # Catalogue pass for one artist
npm run ingest:try -- <artist>     # Dry-run Bandcamp ingest (see below); ingest:mirlo too
npm run preview:release -- <slug>  # Release-page harness :8788 (see below)
npm run sentry:sourcemaps
npm run migrate:link|migrate:dry-run|migrate:list        # Supabase CLI, --linked
```

`npm run build` runs, in order: guides manifest → dispatch feed → changelog feed → guides feed → sitemap → root `tsc -b` → `apps/web` `tsc -b` → `vite build`. Any failure blocks the deploy, so a type error can't ship.

**Every generator must run before `vite build`, and that ordering is load-bearing.** `vite build` fills the published `apps/web/dist` by copying `apps/web/public/`, so anything written there afterwards is never published. Put new generators **before** `cd apps/web`, and verify against the deployed artifact — the log prints success either way. (This shipped a frozen sitemap for four weeks.)

**The test suites are not part of the build** — they run in GitHub Actions (`ci.yml`), because Actions minutes are free here and Netlify builds are not. So **run `npm run verify` before considering work done**, and note that **a red CI run does not stop a deploy**: Netlify builds whatever lands on `main`, which is not branch-protected.

**Typecheck coverage gotcha:** `api/tsconfig.json` has a narrow `include` — the `me-*` functions, `search-sources.ts`, their tests, and whatever those reach (so the search backend is covered). Everything else in `api/` is not: edge functions, `artist-profile.ts`, the release and admin endpoints fail at runtime in production rather than in the build. When touching an unlisted file, lean on the function tests — or add it to that `include` and fix what strict mode surfaces.

## Key patterns

### Search flow

Two-phase.

- **Phase 1** — `GET /api/search/sources` → `search-sources.ts`. Fans out across platforms in parallel (~1-2s), aggregates, disambiguates, returns results. Applies MusicBrainz enrichment server-side when it lands in time; `hasPendingEnrichment` tells the client whether Phase 2 is still needed.
- **Phase 2** — `GET /api/search/musicbrainz` → `search-musicbrainz.ts`. Official sites, socials, location, release verification, Qobuz links. Merged client-side by `mergeWithMusicBrainzData` in `apps/web/src/services/sources.ts`.

Multi-artist queries ("Artist feat. Artist2") are split, searched in parallel, then merged and deduplicated.

`search-sources.ts` holds orchestration and per-platform fetchers, and is already large. `search-utils.ts` holds the pure helpers (`aggregateResults`, `splitSuspiciousPlatforms`, `mergeByReleaseOverlap`, `filterAndSort`, `applyMergeOverrides`) and `search-parsers.ts` the per-platform parsers. **Prefer adding logic there with a test over growing `search-sources.ts`.**

### Bandcamp discovery by subdomain probing

`bandcamp.com/search` is behind a Fastly bot challenge and `Disallow`ed in robots.txt, so it cannot be used. `api/search/bandcamp-probe.ts` derives candidate slugs from the query and requests `<slug>.bandcamp.com/music` (robots-permitted), resolving identity (`data-band`), release counts, location, titles and photo in one request per candidate.

**Verify both identity and substance.** A slug existing doesn't mean it's the right artist; a name matching doesn't mean it's a real presence — parked, empty accounts match `beyonce`, `sufjan`, `jackwhite`. Verdicts: `accepted`, `absent`, `rejected_empty`, `rejected_name`, `undecided`.

Outcomes — **including negatives** — are cached in `bandcamp_slug_probes` (migrations 025–028 plus `20260727090000_bandcamp-probe-probed-slugs.sql`). The `probed_slugs` column records which slugs were actually tried, so a cached negative can't hide an artist whose name has a hyphen.

### Never cache uncertainty

The lesson behind a run of bug fixes (#317–#328); it applies to every cached lookup.

- Distinguish **"the upstream answered with nothing"** (cacheable) from **"the upstream didn't answer"** — timeout, network error, bot challenge, 5xx (never cacheable as a negative). The probe's `undecided` verdict exists so the cache can refuse it.
- `cacheGetOrFetch` (`api/functions/cache.ts`) takes a `shouldCache` predicate and an optional short `failureTtlSeconds`. Use them for anything whose failure mode looks like an empty result.
- Cache keys must not collide across inputs that behave differently — `query_norm` strips punctuation, but punctuation generates extra slug candidates, hence `probed_slugs`.
- A silent `200` with an empty parse is a failure. Report it to Sentry rather than letting it look like "this artist doesn't exist."

### Redis is metered — count round trips, not just correctness

Upstash's free tier is **500,000 commands a month** (~16,600/day) — a *command* budget — and the site exhausted it in August 2026 at low traffic. One user search costs ~10 API requests, so any per-request Redis overhead is multiplied by ten. Four rules:

- **Every extra limiter has to earn its round trip.** Only `strict` has a daily quota — it fronts search, and its 500/day is a documented promise to anonymous v1 callers (`docs/openapi.yaml`). `standard`, `lenient`, `account` keep per-minute windows only (30/120/60).
- **Batch reads that share a request.** `cachePrefetch` reads the fan-out's per-platform keys in one `MGET` and passes each fetcher its value via `cacheGetOrFetch`'s `prefetched` argument; fetchers keep their own TTLs, predicates and write-backs. Add new cached platforms to that key list in `searchAllPlatforms` rather than issuing a separate `GET`.
- **Never spend two commands answering one question.** `checkSentryDedup` is a single `SET ... NX EX`. Prefer `SET NX`, `INCR`, `MGET` over read-then-write pairs.
- **Don't cache a constant** — only a real fetch is worth protecting.

`getMergeOverrides` / `getLinkSuppressions` are the one sanctioned in-process memo (global, tiny, read on every search): 60 seconds in `db.ts` on top of Redis, short enough that `invalidateAdminListCache` keeps its meaning. Don't generalise it.

### Testing release ingest locally

Cataloging only runs where `RELEASE_CATALOG_ENABLED=true`, set for the **Production context only**. Previews and local runs both point at **production** Supabase, so **setting the flag locally is not a valid workaround** — it would have your laptop writing production data and spending the real crawl budget. Use `npm run ingest:try -- <artist>` instead (`--json` for full row shapes, `--detail=3` for dates, formats and prices): it exercises the real fetcher, allowlist check, parser and mapping without touching the database. One Bandcamp request per run; don't loop it.

There is deliberately no `--write`; to test the write path, point `SUPABASE_URL` at a branch database on purpose. And **don't reach for `CONTEXT` or `DEPLOY_PRIME_URL` in a function** — Netlify exposes only `URL`, `SITE_NAME` and `SITE_ID` at runtime, so an earlier `CONTEXT === 'production'` gate silently disabled cataloging entirely.

### Seeing the release page locally

`npm run dev` renders `/a/{artist}/{release}` through the real `api/edge/release-page.ts` and matches production; `dev:fast` runs no edge functions at all. The gap is data — production Supabase only holds a release once cataloging has run for that artist — so `npm run preview:release -- <slug>` (then `http://localhost:8788`) renders any release through the **real** edge function, fetching its Bandcamp page on demand. Only the two database reads are stubbed, so nothing can be written.

`release_catalog_state` is the observability surface (`last_attempted_at`, `releases_found`, `last_error`, `consecutive_failures`, `last_trigger`); `recordCatalogOutcome` reports a sudden drop to 0 releases to Sentry, since a parser break otherwise looks like an ordinary success.

### Keeping catalogues fresh

Catalog triggers are all demand-driven — a save, an artist's own button, the admin command, a collection import — and `check-releases` only *reads* the catalogue, so without a scheduled refresh an artist saved once is catalogued once and their alerts quietly stop. `api/functions/recatalog-sweep.ts` fixes that, run every twelve hours by `recatalog-sweep.yml` at 25 artists per run.

**Search is deliberately not a trigger, directly or via the sweep** — queuing a crawl per Bandcamp-linked search result made an unauthenticated path the site's largest producer of database writes and exhausted the Supabase disk I/O budget; letting every searched artist into the sweep's pool did the same one step removed (the pool grew ~46 artists a day against a sweep of 50, so nearly every slot was a first-time crawl). Don't reintroduce either. The off-switch is the `RELEASE_CATALOG_ENABLED` env var — deleting it in Netlify stops cataloging with no deploy.

**The sweep's attention is demand-gated.** An artist gets a *first* catalogue only if they are saved by a fan, hold a verified claim, or appear in a connected Bandcamp collection — and since disk I/O round 6 (2026-09-19) the same three signals gate the *refresh* too: an artist already catalogued whom nobody follows is frozen rather than re-crawled (their `release_catalog_state` row stays, their page keeps showing the stored catalogue; prices go stale, the page does not empty). Everyone else with a crawlable link is counted as `awaitingDemand` (never catalogued) or `frozenCatalogues` (catalogued, frozen) in the sweep's log and left alone. Crawlable means **a bandcamp, discogs, faircamp, jam.coop or mirlo link** (`CATALOGUEABLE_PLATFORMS` in `db.ts`). **Keep that list identical to `catalogArtist`'s equivalent check** — an artist with only an official site is recorded as a *failure*, so sweeping them poisons `consecutive_failures`; the two change together (#415 added Mirlo to both). The sweep asks `requestArtistCatalog` for up to 25 under the `scheduled` trigger, but `claimArtistForCatalog` (7-day cooldown plus per-trigger hourly cap) is the authority, so running it twice is a no-op.

**Paging, not `.limit()`.** PostgREST caps every response at 1,000 rows whatever limit you ask for, and truncates *silently* — a `.select()` over `artist_links` returns 1,000 of ~3,900 rows and looks successful. Use `readAllPages` (or `.range()` in a loop) for any read whose table can exceed 1,000 rows.

### Platform registry

`api/shared/platform-registry.ts` is the single source of truth for platform metadata: name, color, icon, category (marketplace, patronage, decentralized, library, official, social), payout percentage, AI policy, `CATEGORY_ORDER`. Add or change platforms there rather than hardcoding elsewhere, then check for stale copies:

```bash
grep -r "PLATFORM_INFO" api/edge/ apps/web/src/
```

`apps/web/src/services/sources.ts` mirrors the registry and adds client-only fields (description, `searchUrlTemplate`, `hasEmbed`, `searchOnly`). Keep the shared fields in sync.

### Local dev: the full stack, and the fast shim

**Use `npm run dev` — the real one — by default.** It is the *only* way to exercise the real backend before merging, because #451 disabled Deploy Previews outright; treat a gap in it as a real gap.

| | `npm run dev` (`netlify dev`, :8888) | `npm run dev:fast` (Vite, :5173) |
|---|---|---|
| Netlify functions (`api/functions/`) | **real** | not run — `apps/web/server/` shim |
| Edge functions (`api/edge/`) | **real** | not run at all |
| `netlify.toml` redirects, headers, routing | **applied** | ignored |
| Supabase data | **production** | none |
| Auth (sign-in, sessions, admin) | **works** | dead — "Auth not configured" |
| `/data/**` (guides, changelog) | served | 404s as the SPA shell |
| Boot | ~15s | ~1s |

`dev:fast` is for pure CSS/layout iteration. Anything touching data, auth, an API response, SEO markup or routing needs `npm run dev`.

**It reads and writes PRODUCTION Supabase.** `netlify dev` injects the live site's environment, so functions hold `SUPABASE_SERVICE_KEY` and bypass RLS as production does. Reads are free; **writes are real** — saving an artist, claiming a profile or changing settings mutates production rows, and `RESEND_API_KEY` / `BUTTONDOWN_API_KEY` mean notification paths can send real email. Cataloguing is the one thing that stays off; don't "fix" that.

Three traps, all producing a *silently wrong* result rather than an error:

- **The empty-value shadow.** A key present but blank in `.env` overrides the real value from the Netlify site settings, logged as `Ignored project settings env var: X`. **Delete a key from `.env` rather than leaving it blank**, and check the startup log's `Injected project settings env vars` list — a key you need belongs there, not in an `Ignored` line. Three blank keys are why local auth never worked until 2026-08-15.
- **The stale port.** `dev:fast` passes `--strictPort` on purpose; the `[dev]` block in `netlify.toml` says why removing it lets another checkout's leftover server answer everything.
- **The shim is not the backend.** Only `dev:fast` uses `apps/web/server/`, whose search implementation has drifted. Editing `search-sources.ts` does not change what `dev:fast` returns; editing `apps/web/server/*` does not change production. Concretely, the shim's `/api/suggest` returns a hardcoded empty list where `npm run dev` returns real `artists` rows.

`npm run dev` rewrites `deno.lock`; `git checkout -- deno.lock` before committing, same habit as the generated feed XML.

### Dead code in `api/search/`

`api/search/sources.ts`, `bandcamp.ts`, `site-search.ts` and `musicbrainz.ts` are Vercel-era leftovers (they import `@vercel/node`, which isn't even a dependency) and are imported by nothing — only `bandcamp-probe.ts` and `enrichment.ts` there are live. Editing the dead files is a classic wasted-session trap: the change deploys and nothing happens. Verified in `docs/specs/bandcamp-coverage-research.md` §1.

### Feature surfaces

- **Artist profiles.** Artists claim via `/claim/:slug` (magic link or password, with a manual-review fallback); the flow is a wizard split across `Claim*Step.tsx`. Claimed profiles are edited at `/artist-edit/:slug`. Artist pages render at `/a/:slug` and `/artist/:slug` via the `artist-page-static` edge function, and analytics (searches, views, clicks) appear on the artist dashboard.
- **Saved & supported artists.** Signed-in fans save artists and mark them supported (migrations 013–018), synced to the Apple app via `saved-artists-sync.ts` with tombstones and scheduled GC. A claimed public username (migration 021) plus a sharing opt-in (022) renders a public list at `/u/:handle` via the `u-handle` edge function, backed by `public-saved-artists.ts`; reserved handles live in `api/lib/reserved-handles.ts`.
- **Account settings.** `/settings` is backed by the `me-*` functions (`me-settings`, `me-username`, `me-location`, `me-password`) plus `user-sharing.ts`. These are the only files in `api/tsconfig.json`'s typecheck include and each has a test in `api/functions/__tests__/` — **follow that pattern for new account endpoints.**
- **Public API (v1).** Documented in `docs/openapi.yaml`, surfaced on `/developers`, routed in `netlify.toml`: `/api/v1/search`, `/artist/*`, `/resolve`, `/platforms`, `/status`, `/keys`. Keys are stored hashed (migration 007); key-bearing requests get permissive CORS, anonymous ones are restricted to `unstream.stream`.
- **Discord bot.** `discord-interaction.ts` verifies signatures (tweetnacl) and dispatches to `discord-search-background.ts`; commands are registered with `scripts/discord-register-commands.ts`.
- **Guides.** Markdown in `data/guides/` with YAML frontmatter (title, description, pillar, published/draft); manifest generated at build time by `scripts/generate-guides-manifest.ts`. Pillars: artist-economics, platform-discovery, how-to, builder.
- **Admin tools.** Admins (checked by email) merge duplicate results at `/admin/merge`, review verification at `/admin/verify`, and view `/admin/analytics`. Merge overrides live in Supabase (migrations 004–005), are respected during disambiguation, and can be managed with `npx tsx scripts/merge-override.ts`.

### Release dedup: what identity is, and what the date is for

One release exists on several platforms, described differently by each. **Under-merge, never over-merge** — a false merge asserts an artist made a record they didn't, and nobody would ever catch it. Three tiers:

1. **A hard identifier** (`discogs_master_id`, `musicbrainz_release_group_id`) — someone else's "these pressings are one album" conclusion. Wins outright.
2. **Identical `match_key`, unless the dates disagree** (`findExactReleaseMatch`). Merges.
3. **Containment between match keys, unless the dates disagree** (`findFuzzyReleaseMatch`). Never merges — flags both rows `needs_review` for `/admin/release-review`.

Three measured rules hold that together:

- **Release type is not identity, and restoring it would be a regression.** Discogs has no type field for a master, so 92% of its rows are `other` where Bandcamp says `album`; keying on `(release_type, match_key)` left 1,181 identical-title pairs duplicated on artist pages, unmerged *and* unflagged.
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

Routed in `netlify.toml`: `/` → `og-metadata`; `/artist/*` and `/a/*` → `artist-page-static`; `/search` → `noscript-search`; `/guides/*` → `guide-page`; `/u/*` → `u-handle`.

`/artists` is SPA-only after UNS-98; `artist-directory-page` was removed. Edge functions run on Deno and import from URLs (`edge.netlify.com`, `esm.sh`) — they can't import from `api/functions/`, so shared constants get duplicated or pulled from `api/shared/`.

### The Dispatch

A weekly music-industry briefing. **The workflow changed on 2026-04-17:** it is delivered to the `#unstream-dispatch` Discord channel by a scheduled agent, and RSS publishing was retired — nothing new is written to `data/dispatch/`. What remains is the archive plus `scripts/generate-dispatch-feed.ts`, which still runs at build time so `/dispatch.xml` renders the historical feed.

The old "commit dispatch work directly to `main`" instruction is dead — do not follow it.

### API middleware & security

`api/functions/middleware.ts` centralizes CORS (`buildCorsHeaders` / `buildPublicCorsHeaders`), auth (`authenticateBearer`, `authenticateAdmin`, `authenticateApiKey`), query validation (`validateQuery`), v1 envelopes (`v1Response`), and SSRF protection.

SSRF protection is an **explicit hostname allowlist** — `ALLOWED_OUTBOUND_HOSTNAMES` + `isUrlHostnameAllowed()`. All outbound fetches must pass through it, and a new platform fetch means adding its hostname (wildcards like `*.bandcamp.com` work). It also blocks non-HTTP(S) schemes, localhost and cloud metadata endpoints. Its comments record *why* hosts were removed (e.g. no `qobuz.com`: robots-disallowed, links come from MusicBrainz relations and are displayed but never fetched) — preserve that reasoning when editing.

Rate limits and Sentry dedup live in `ratelimit.ts` (`checkRateLimit`, `checkApiRateLimit`, `checkSentryDedup`).

## Auth

Supabase Auth with magic links and password sign-in. Auth state is managed via `AuthContext` (`apps/web/src/contexts/`), which also holds saved artists. Admin status is checked against the user's email. RLS policies protect all database tables — add/adjust policies in a migration when introducing new tables or columns.

## Database / migrations

Schema lives in `supabase/schema.sql`; changes ship as timestamp-prefixed files in `supabase/migrations/` (e.g. `20260726120000_bandcamp-slug-probes.sql`), and **filename order is what Supabase applies**. The sequential `-- Migration NNN` header comments and the older `migration-NNN-*.sql` copies are historical reference only — the sequence has gaps. Don't edit historical migrations.

When adding a table or column: new migration, RLS policies included, `IF NOT EXISTS` / `DROP ... IF EXISTS` guards for idempotency, comments explaining the change. Server-only tables (like `bandcamp_slug_probes`) enable RLS with *no* policies — the service-role client bypasses RLS, anon gets nothing — and should say so in a comment so the missing policies don't read as an oversight.

**Auto-deploy:** `supabase-migrate.yml` runs `supabase db push --linked` on every push to `main` touching `supabase/migrations/`. Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.

**Applying a migration to production from an unmerged branch poisons every later migration.** `supabase db push` aborts *before applying anything* when production has a version missing locally, so one migration left on an unmerged branch silently blocks everybody's migrations on `main` — it happened, and took release alerts down for 30 hours. If you run the workflow by hand from a branch, merge it promptly and **check the workflow went green**; the failure is loud in Actions and invisible everywhere else.

**Local dry-run:** `npm run migrate:link` once, then `npm run migrate:dry-run`. Both that and `migrate:list` use `--linked`; the CLI dropped `--project-ref`, and passing it prints a help blob and exits *without checking anything*, which reads like a clean run. If you see `Cannot find project ref`, run the link step. The dry run can't validate SQL — for that, run the migration against a throwaway Postgres in Docker.

## Testing

Vitest, in three places:

- `apps/web/tests/unit/` — component and pure-logic tests. Run in CI.
- `apps/web/tests/integration/` — search accuracy against live APIs (`tests/fixtures/expected-results.json`). Separate; not in CI.
- `api/functions/__tests__/` — function tests (cache behavior, probe cache coverage, XSS defense, the `me-*` endpoints). In CI via `npm run test:api`.

`npm run verify` runs the CI gate locally. `npm run lint` is *not* in it: ESLint reports 64 pre-existing errors (unused vars and `any` in test files, plus a few pages), so enforcing it would fail every PR for unrelated reasons — worth clearing separately, advisory until then.

The root `vitest.config.ts` covers both trees so `npx vitest` works from the repo root; `apps/web/vitest.config.ts` covers the web tree. Default environment is `node` — add `// @vitest-environment jsdom` atop a `.tsx` test needing a DOM. Both alias `src` → `apps/web/src`. The Apple app has XCTest coverage in `apps/mac/UnstreamTests/`.

## Deployment

Pushes to `main` trigger Netlify builds (`npm run build`). Functions deploy from `api/functions/`, edge functions from `api/edge/`; edge routes, `/api/*` redirects and headers/CSP live in `netlify.toml`.

**Not every push deploys.** `netlify.toml`'s `ignore` setting runs `scripts/netlify-ignore-build.sh`, which cancels the build when a push touches only paths Netlify never publishes — `apps/mac/`, `apps/extension/`, `supabase/`, `docs/`, `.github/`, `README.md`, `CLAUDE.md`. **Its exit code is inverted: 0 cancels, 1 builds**, and every branch defaults to deploying, because a skipped deploy leaves production silently stale. `data/` and `scripts/` are deliberately absent, since `data/` is copied into `dist/` and `scripts/` generates the manifests, feeds and sitemap — so if you add a path whose contents reach the built site, check it isn't shadowed.

**Deploy Previews are off.** `[context.deploy-preview]` cancels them (`ignore = "exit 0"`), so a PR gets no preview URL and its Netlify checks don't run — configuration, not breakage. **`npm run dev` is therefore the only way to exercise the real backend before merging.**

GitHub Actions: `ci.yml` (typecheck + both suites — the gate that used to live in the Netlify build) · `supabase-migrate.yml` · `schedule-social-posts.yml` (weekly, committed back) · `semantic-revert-check.yml` (runs `scripts/semantic-revert-check.py` to flag changes that quietly undo earlier fixes — take it seriously; bug loops in `docs/postmortems/UNS-100-bifurcation-retro.md`) · `upstash-keepalive.yml` · `recatalog-sweep.yml` (every 12h).

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
- **One route, one renderer.** If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. "Two renderers for one URL" causes back-button / bfcache breakage and bug loops where every fix partially reverts the last (`docs/postmortems/UNS-100-bifurcation-retro.md`, UNS-70/71/73/94/97/99/100). When you need both crawler HTML *and* React interactivity, use a pure-SSR edge function as the no-JS fallback and the SPA as the in-app renderer, and never let the SPA "take over" from the static response. `/u/:handle` is the reference: edge renders, React hydrates only a Copy URL button.
- **Respect other people's servers.** Check `robots.txt` before adding a scrape and honor it — several outages here were self-inflicted by scraping disallowed paths. Prefer documented APIs, directories and sitemaps; cache aggressively.

### Security practices

Treat security as part of "done," not a later pass. Flag anything you can't fully resolve rather than leaving it silent.

- **Validate and sanitize all external input** at the boundary — query params, bodies, URL params, webhook payloads. Escape anything interpolated into edge-function HTML (`escapeHtml`); `api/functions/__tests__/xss-defense.test.ts` guards this.
- **SSRF protection is mandatory** for any code fetching an external URL. Route fetches through `isUrlHostnameAllowed()` and add hosts to `ALLOWED_OUTBOUND_HOSTNAMES`; never add a raw `fetch(userUrl)`.
- **Respect the CORS/auth model.** Public endpoints stay restricted to `unstream.stream`; API-key requests get permissive CORS because the key is the authorization. Use the shared middleware.
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
