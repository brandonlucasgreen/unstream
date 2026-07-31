# Unstream - Development Guide

## Project overview

Unstream helps music listeners find their favorite artists on alternative platforms outside streaming, so they can support artists directly. It searches ~17 platforms (Bandcamp, Mirlo, Ampwall, Subvert, Beatport, Faircamp, Jam.coop, Patreon, etc.) and shows verified links grouped by category with artist payout percentages. On Bandcamp Fridays, results highlight the platforms that pay artists 100%.

The product runs at [unstream.stream](https://unstream.stream).

## Architecture

- **Frontend**: React 19 SPA with React Router 7, Tailwind CSS v4, Vite 7, TypeScript. PWA-enabled (`vite-plugin-pwa`). Most pages are lazy-loaded in `apps/web/src/main.tsx`.
- **Backend**: Netlify Functions (serverless API, `api/functions/`) + Edge Functions (SSR/SEO, `api/edge/`). Functions are TypeScript on Node; edge functions run on Deno (see `deno.lock`).
- **Local dev API**: a Vite middleware in `apps/web/server/` — a *separate* implementation from `api/functions/`. See "Local dev API vs production API" below; this trips people up.
- **Database**: Supabase (Postgres with RLS) for artist profiles, analytics, merge overrides, API keys, verification requests, saved/supported artists, public usernames, and the Bandcamp probe cache.
- **Data enrichment**: MusicBrainz, Wikidata, Wikipedia, Discogs, Linktree, Bandcamp artist pages.
- **Caching / rate limiting**: Upstash Redis (`@upstash/ratelimit`, `api/functions/cache.ts`, `api/functions/ratelimit.ts`).
- **Error monitoring**: Sentry — `@sentry/react` on the web app (`apps/web/src/services/sentry.ts`), `@sentry/node` in functions (`api/lib/sentry.ts`). Source maps uploaded via `npm run sentry:sourcemaps`.
- **Analytics**: GoatCounter (public) + custom Supabase analytics (artist dashboard, `/admin/analytics`).
- **Integrations**: Public REST API (v1), Discord slash-command bot, social post automation, ListenBrainz scrobbling (apps).
- **Clients**: web app, universal Apple app (macOS menu bar + iOS, SwiftUI), browser extension (Chrome + Firefox, MV3).
- **Hosting**: Netlify.

## Repository structure

```
unstream/
├── apps/
│   ├── web/                    # React + Vite SPA
│   │   ├── src/
│   │   │   ├── components/     # Shared UI (ResultCard*, Claim* steps, Header, SearchBar, skeletons, …)
│   │   │   ├── pages/          # Route page components
│   │   │   ├── services/       # sources.ts (platform config + search client), auth, analytics, sentry
│   │   │   ├── contexts/       # AuthContext (Supabase auth + saved artists)
│   │   │   ├── hooks/          # usePWA, useTheme
│   │   │   ├── data/           # FAQ content, static data
│   │   │   ├── types/          # TypeScript interfaces
│   │   │   └── utils/          # Markdown renderer, colors, bandcamp-friday helpers
│   │   ├── server/             # DEV-ONLY API served by Vite (see note below)
│   │   ├── public/             # Static assets + generated sitemap.xml, dispatch.xml
│   │   └── tests/              # unit/ + integration/ + fixtures/ (Vitest)
│   ├── mac/                    # Universal Apple app (macOS menu bar + iOS), SwiftUI
│   │   ├── project.yml         # XcodeGen project definition (source of truth for targets)
│   │   ├── Unstream/
│   │   │   ├── Views/          # macOS / iOS / Shared SwiftUI views
│   │   │   ├── Services/       # Release checkers (Bandcamp, Mirlo, Faircamp), auth, sync, keychain, Plex
│   │   │   ├── Platform/macOS/ # Media observer, hotkey, scrobbling, notifications, updates
│   │   │   ├── StoreKit/       # In-app support purchases (tip jar)
│   │   │   └── Models/         # AppState, NowPlaying, ReleaseAlert, PlatformCatalog, …
│   │   ├── UnstreamShareExtension/  # Share-sheet extension
│   │   └── UnstreamTests/      # XCTest (saved-artists sync)
│   └── extension/              # Browser extension (Chrome + Firefox), MV3
│       ├── content/            # Content scripts per streaming site (spotify, apple-music, …)
│       ├── popup/              # Extension popup UI
│       ├── background/         # Service worker
│       ├── lib/                # constants, supabase, custom-sites, bandcamp-friday
│       └── manifest.json / manifest-firefox.json
├── api/
│   ├── functions/              # Netlify serverless functions — the live backend
│   │   ├── search-sources.ts   # Phase 1 search orchestration (the big one)
│   │   ├── search-musicbrainz.ts  # Phase 2 enrichment endpoint
│   │   ├── search-utils.ts     # Pure helpers: normalize, aggregate, disambiguate, merge, sort
│   │   ├── search-parsers.ts   # Pure HTML/JSON parsers per platform
│   │   ├── middleware.ts       # CORS, auth, query validation, SSRF allowlist
│   │   ├── cache.ts            # Upstash cache-aside helpers
│   │   ├── ratelimit.ts        # Rate limits + Sentry dedup
│   │   ├── db.ts               # Supabase service-role access (profiles, overrides, probes)
│   │   └── __tests__/          # Vitest tests for functions
│   ├── edge/                   # Edge functions: og-metadata, artist-page-static, guide-page,
│   │                           #   noscript-search, u-handle
│   ├── search/                 # bandcamp-probe.ts + enrichment.ts are LIVE.
│   │                           #   sources.ts / bandcamp.ts / site-search.ts / musicbrainz.ts are DEAD
│   │                           #   Vercel-era code — do not edit them (see note below).
│   ├── embed/                  # Bandcamp embed resolver
│   ├── shared/                 # platform-registry.ts (canonical platforms), bandcamp-friday.ts
│   ├── lib/                    # sentry.ts, reserved-handles.ts
│   └── scripts/                # sentry-test.ts and other function-side scripts
├── scripts/                    # Data generation + ops (artist list/data, sitemap, social posts,
│                               #   guides manifest, dispatch feed, bandcamp date sync,
│                               #   discord command registration, merge-override CLI,
│                               #   semantic-revert-check, sentry sourcemaps)
├── data/
│   ├── artists/                # Pre-generated artist SEO JSON (~790 files)
│   ├── artists-manifest.json   # Index of those artists (feeds sitemap + social posts)
│   ├── guides/                 # Markdown guide posts with frontmatter + generated manifest
│   ├── dispatch/               # Archived Dispatch markdown + README (see Dispatch below)
│   ├── social-posts/           # Generated/scheduled social post history
│   ├── artist-list.json        # Wikidata-sourced artist list
│   └── shipped-features.json   # Changelog/roadmap data (served to /changelog)
├── supabase/                   # schema.sql + migrations/ (timestamp-prefixed)
│                               #   + historical migration-NNN-*.sql copies
├── docs/                       # Specs, research, retros, OpenAPI spec, product/positioning docs
└── netlify.toml                # Edge function routes, /api/* redirects, headers/CSP
```

## Commands

```bash
npm install               # Install dependencies
npm run dev               # Start Vite dev server (apps/web) with the dev API middleware
npm run build             # Full build — see below for exactly what it runs
npm run lint              # ESLint (apps/web)

npm run test              # Everything: web tests + API function tests
npm run test:web          # All apps/web tests (unit + integration)
npm run test:unit         # apps/web/tests/unit only (runs in the build pipeline)
npm run test:integration  # apps/web/tests/integration only (hits live APIs; run separately)
npm run test:api          # api/functions/**/*.test.ts (runs in the build pipeline)
npm run test:watch        # Vitest watch mode (apps/web)

npm run typecheck:api     # tsc --noEmit over api/ (NOTE: narrow include — see below)
npm run preview           # Preview the built SPA

npm run generate:artists  # Fetch artist list from Wikidata
npm run generate:data     # Generate artist page JSON + artists-manifest.json via APIs
npm run generate:social   # Generate social media posts via Buffer
npm run sync:bandcamp-dates  # Sync Bandcamp release dates
npm run ingest:try -- <artist>   # Dry-run release ingest against a real Bandcamp page
npm run sentry:sourcemaps    # Upload source maps to Sentry
npm run migrate:dry-run   # supabase db push --dry-run against the linked project
npm run migrate:list      # List applied vs pending migrations
```

`npm run build` runs, in order: guides manifest → dispatch feed → root `tsc -b` → API function tests → `apps/web` `tsc -b` → web unit tests → `vite build` → sitemap. **Any failure blocks the Netlify deploy.** Run `npm run build` (or at minimum `npm run lint`, `npm run test:unit`, `npm run test:api`) before considering work done.

**Typecheck coverage gotcha:** `api/tsconfig.json` has a narrow `include` — only the `me-*` functions and their tests. So neither `tsc -b` nor `npm run typecheck:api` typechecks most of `api/`. A type error in `search-sources.ts` will not fail the build; it will fail at runtime in production. When you touch `api/`, rely on the function tests and read carefully — and if you add a file worth typechecking, add it to that `include` list.

## Key patterns

### Search flow

Two-phase.

- **Phase 1** — `GET /api/search/sources` → `api/functions/search-sources.ts`. Fans out across platforms in parallel (~1-2s), aggregates, disambiguates, and returns results. Also applies MusicBrainz enrichment server-side when it lands in time; the response's `hasPendingEnrichment` tells the client whether Phase 2 is still needed.
- **Phase 2** — `GET /api/search/musicbrainz` → `api/functions/search-musicbrainz.ts`. Official sites, social profiles, location, release verification, Qobuz links. Merged into the rendered results client-side (`mergeWithMusicBrainzData` in `apps/web/src/services/sources.ts`).

Multi-artist queries (e.g. "Artist feat. Artist2") are split, searched in parallel, then merged and deduplicated.

Where the code lives:

- `api/functions/search-sources.ts` — orchestration and per-platform fetchers. Large; keep new pure logic out of it.
- `api/functions/search-utils.ts` — pure helpers (normalization, `aggregateResults`, `splitSuspiciousPlatforms`, `mergeByReleaseOverlap`, `filterAndSort`, `applyMergeOverrides`). Unit-testable, no network.
- `api/functions/search-parsers.ts` — pure HTML/JSON parsers per platform. Also unit-testable.
- `api/search/enrichment.ts` and `api/search/bandcamp-probe.ts` — shared modules used by both search functions.

Prefer adding logic to `search-utils.ts` / `search-parsers.ts` with a test over growing `search-sources.ts`.

### Bandcamp discovery by subdomain probing

`bandcamp.com/search` is behind a Fastly bot challenge and `Disallow`ed in Bandcamp's robots.txt, so it cannot be used. Instead `api/search/bandcamp-probe.ts` derives candidate slugs from the query and requests `<slug>.bandcamp.com/music` (robots-permitted). One request per candidate resolves identity (`data-band`), release counts, location, release titles, and the artist photo.

Both verification steps are load-bearing: a slug existing doesn't mean it's the right artist, and a name matching doesn't mean it's a real presence (parked, empty accounts match `beyonce`, `sufjan`, `jackwhite`). Verdicts: `accepted`, `absent`, `rejected_empty`, `rejected_name`, `undecided`.

Outcomes are cached in Supabase (`bandcamp_slug_probes`, migrations 025–028 plus `20260727090000_bandcamp-probe-probed-slugs.sql`), including negatives — otherwise every search for an artist who simply isn't on Bandcamp re-probes forever. Background: `docs/specs/bandcamp-coverage-research.md`.

### Never cache uncertainty

This is the lesson behind a run of bug fixes (#317–#328) and it applies to every cached lookup, not just Bandcamp:

- Distinguish **"the upstream answered with nothing"** (cacheable) from **"the upstream didn't answer"** — timeout, network error, bot challenge, 5xx (not cacheable as a negative). The probe's `undecided` verdict exists precisely so it can be refused by the cache.
- `cacheGetOrFetch` in `api/functions/cache.ts` takes a `shouldCache` predicate plus an optional short `failureTtlSeconds`. Use them for anything whose failure mode looks like an empty result.
- Cache keys must not collide across inputs that behave differently. `query_norm` strips punctuation, but punctuation is what generates extra slug candidates — hence the `probed_slugs` column, which records which slugs were actually tried so a cached negative can't hide an artist whose name has a hyphen.
- A silent `200` with an empty parse is a failure. Report it (Sentry) rather than letting it look like "this artist doesn't exist."

### Testing release ingest locally

Release cataloging only runs when `CONTEXT === 'production'`, because deploy previews and local
runs both point at the **production** Supabase — so an ungated preview would write real
`releases` rows and spend the real hourly crawl budget. That means ingest cannot be exercised
on a deploy preview, and **`CONTEXT=production` is not a valid local workaround** — it would
have your laptop writing production data.

Use the dry run instead:

```bash
npm run ingest:try -- sufjanstevens              # table of what would be written
npm run ingest:try -- sufjanstevens --json       # full row shapes
npm run ingest:try -- sufjanstevens --detail=3   # + dates, formats and prices for the newest 3
```

It runs the real path — the same SSRF-safe fetcher, the same allowlist check, the same parser
and mapping production uses — and prints the result without touching the database. One Bandcamp
request per run; don't loop it.

There is deliberately no `--write` flag. Everything with a decision in it lives upstream of the
database, and `persistReleases` is covered by unit tests plus a migration validated against a
real Postgres. To test the write path, point `SUPABASE_URL` at a branch database on purpose.

### Seeing the release page locally

`npm run dev` **cannot** show you `/a/{artist}/{release}` — the Vite dev server doesn't run edge
functions at all. `netlify dev` does, but it reads the production Supabase, where a release only
exists once demand-driven cataloging has run for that artist. So the page you most want to look
at is the one neither of those can render.

```bash
npm run preview:release -- explosionsinthesky    # then open http://localhost:8788
```

Fetches the real `/music` grid, lists the discography, and renders any release through the
**real** `api/edge/release-page.ts` — same template, same payout maths — fetching that release's
page from Bandcamp on demand. Only the two database reads are stubbed; there is no database
connection, so nothing can be written. One Bandcamp request per release page you open.

Once ingest is live, `release_catalog_state` is the observability surface:
`last_attempted_at`, `releases_found`, `last_error`, `consecutive_failures`. A run that suddenly
finds 0 releases where it previously found 20 is a parser break or a bot challenge, not an
artist deleting their catalog.

### Platform registry

`api/shared/platform-registry.ts` is the single source of truth for platform metadata: name, color, icon, category (marketplace, patronage, decentralized, library, official, social), payout percentage, AI policy, and `CATEGORY_ORDER`. Add or change platforms there rather than hardcoding elsewhere, then check for stale copies:

```bash
grep -r "PLATFORM_INFO" api/edge/ apps/web/src/
```

`apps/web/src/services/sources.ts` mirrors the registry and adds client-only fields (description, `searchUrlTemplate`, `hasEmbed`, `searchOnly`). Keep the shared fields in sync between the two.

### Local dev API vs production API

`npm run dev` does **not** run the Netlify functions. `apps/web/vite.config.ts` installs `handleApiRequest` from `apps/web/server/api.ts`, which has its own search implementation in `apps/web/server/search/*`. So:

- Editing `api/functions/search-sources.ts` does not change what `npm run dev` returns.
- Editing `apps/web/server/*` does not change production.
- The two have drifted. Treat `api/functions/` as the real behavior; treat `apps/web/server/` as a convenience shim for UI work, and update it only when you need dev parity.

When a change must be verified against the real backend, test the deployed branch (Netlify deploy preview) or write a function test rather than trusting the dev server.

### Dead code in `api/search/`

`api/search/sources.ts`, `bandcamp.ts`, `site-search.ts`, and `musicbrainz.ts` are Vercel-era leftovers (they import `@vercel/node`, which isn't even a dependency) and are imported by nothing. Only `bandcamp-probe.ts` and `enrichment.ts` in that directory are live. Editing the dead files is a classic wasted-session trap: the change deploys and nothing happens. Verified in `docs/specs/bandcamp-coverage-research.md` §1.

### Artist profiles

Artists claim profiles via `/claim/:slug` (email magic link or password auth, with a manual-review fallback path). The claim flow is a multi-step wizard split across `Claim*Step.tsx` components. Claimed profiles are edited at `/artist-edit/:slug` (bio, photo, links, location, featured release embed). Artist pages (claimed and unclaimed) render at `/a/:slug` and `/artist/:slug` via the `artist-page-static` edge function. Analytics (searches, views, clicks) appear on the artist dashboard.

### Saved & supported artists, and public sharing

Signed-in fans can save artists and mark artists as supported (migrations 013–018), synced to the Apple app via `saved-artists-sync.ts` with tombstones and scheduled GC. Users can claim a public username (migration 021) and opt into sharing their list (migration 022); the public list renders at `/u/:handle` via the `u-handle` edge function, backed by `public-saved-artists.ts`. Reserved handles live in `api/lib/reserved-handles.ts`.

### Account settings

`/settings` is backed by the `me-*` functions: `me-settings.ts`, `me-username.ts`, `me-location.ts`, `me-password.ts`, plus `user-sharing.ts` for the sharing toggle. These are the only files in `api/tsconfig.json`'s typecheck include, and each has a test in `api/functions/__tests__/` — follow that pattern for new account endpoints.

### Public API (v1)

A versioned REST API for third parties, documented in `docs/openapi.yaml` and surfaced on `/developers`. Routes (see `netlify.toml`): `/api/v1/search`, `/api/v1/artist/*`, `/api/v1/resolve`, `/api/v1/platforms`, `/api/v1/status`, `/api/v1/keys`. API keys are stored hashed in Supabase (migration 007); requests carrying a key get permissive CORS, anonymous requests are restricted to `unstream.stream`. See `api/functions/middleware.ts`.

### Discord bot

Slash-command bot: `discord-interaction.ts` verifies signatures (tweetnacl) and dispatches to `discord-search-background.ts` for async search responses. Commands are registered with `scripts/discord-register-commands.ts`.

### Edge functions (SSR/SEO)

Edge functions in `api/edge/` handle SSR for SEO, routed in `netlify.toml`:

| Route | Function |
|---|---|
| `/` | `og-metadata` |
| `/artist/*`, `/a/*` | `artist-page-static` |
| `/search` | `noscript-search` |
| `/guides/*` | `guide-page` |
| `/u/*` | `u-handle` |

`/artists` is SPA-only after UNS-98; the `artist-directory-page` edge function was removed. Edge functions run on Deno and import from URLs (`https://edge.netlify.com`, `https://esm.sh/...`) — they can't import from `api/functions/`, so shared constants get duplicated or pulled from `api/shared/`.

### Guides

Markdown files in `data/guides/` with YAML frontmatter (title, description, pillar, published/draft). A manifest is generated at build time (`scripts/generate-guides-manifest.ts`). Pillars: artist-economics, platform-discovery, how-to, builder.

### The Dispatch

A weekly music-industry briefing. **The workflow changed on 2026-04-17:** the Dispatch is now delivered to the `#unstream-dispatch` Discord channel by a scheduled agent, and RSS publishing was retired. Nothing new is written to `data/dispatch/`.

What remains in the repo is the archive: `data/dispatch/2026-W16.md` and earlier, plus `scripts/generate-dispatch-feed.ts`, which still runs at build time so `/dispatch.xml` keeps rendering the historical feed. See `data/dispatch/README.md` for the full history.

The old "commit dispatch work directly to `main`" instruction is dead — do not follow it. Dispatch-related repo changes go through the normal branch workflow like everything else.

### Admin tools

Admin users (checked by email) can merge duplicate search results via `/admin/merge`, review verification requests via `/admin/verify`, and view `/admin/analytics`. Merge overrides are stored in Supabase (migrations 004–005) and respected during search disambiguation; they can also be managed from the CLI with `npx tsx scripts/merge-override.ts`.

### API middleware & security

`api/functions/middleware.ts` centralizes CORS (`buildCorsHeaders` / `buildPublicCorsHeaders`), authentication (`authenticateBearer`, `authenticateAdmin`, `authenticateApiKey`), query validation (`validateQuery`), v1 response envelopes (`v1Response`), and SSRF protection.

SSRF protection is an **explicit hostname allowlist** — `ALLOWED_OUTBOUND_HOSTNAMES` + `isUrlHostnameAllowed()`. Any code fetching an external URL must pass through it, and adding a new platform fetch means adding its hostname (wildcards like `*.bandcamp.com` are supported). The allowlist also blocks non-HTTP(S) schemes, localhost, and cloud metadata endpoints. Its comments record *why* hosts were removed (e.g. no `qobuz.com`: robots-disallowed, links come from MusicBrainz relations and are displayed but never fetched) — preserve that reasoning when editing.

Rate limits and Sentry event dedup live in `api/functions/ratelimit.ts` (`checkRateLimit`, `checkApiRateLimit`, `checkSentryDedup`); Sentry itself is wired in via `api/lib/sentry.ts`.

## Auth

Supabase Auth with magic links and password sign-in. Auth state is managed via `AuthContext` (`apps/web/src/contexts/`), which also holds saved artists. Admin status is checked against the user's email. RLS policies protect all database tables — add/adjust policies in a migration when introducing new tables or columns.

## Database / migrations

Schema lives in `supabase/schema.sql`; changes are applied as timestamp-prefixed migration files in `supabase/migrations/` (e.g. `20260726120000_bandcamp-slug-probes.sql`). Filename order is what Supabase applies. Most files also open with a sequential number in a header comment (`-- Migration 025: …`) matching the older `supabase/migration-NNN-*.sql` copies, which are historical and kept for reference only; the sequence has gaps and a few recent files skip the number entirely, so don't treat it as authoritative. Don't edit historical migrations.

When adding a table or column: create a new migration in `supabase/migrations/`, include RLS policies, use `IF NOT EXISTS` / `DROP ... IF EXISTS` guards for idempotency, and explain the change in comments. Server-only tables (like `bandcamp_slug_probes`) enable RLS with *no* policies — the service-role client bypasses RLS, anon gets nothing — and should say so in a comment so the missing policies don't read as an oversight.

**Auto-deploy:** `.github/workflows/supabase-migrate.yml` runs `supabase db push --linked` on every push to `main` that changes `supabase/migrations/`. Migrations deploy automatically — no manual SQL editor needed. Required GitHub secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`. Local dry-run: `npm run migrate:dry-run`.

## Testing

Tests use Vitest, in two places:

- `apps/web/tests/unit/` — component and pure-logic tests. Run in the build pipeline.
- `apps/web/tests/integration/` — search accuracy against live APIs (`apps/web/tests/fixtures/expected-results.json`). Run separately; not in the build.
- `api/functions/__tests__/` — function tests (cache behavior, probe cache coverage, XSS defense, the `me-*` endpoints). Run in the build pipeline via `npm run test:api`.

Config: the root `vitest.config.ts` lets `npx vitest` work from the repo root and covers both trees; `apps/web/vitest.config.ts` covers the web tree. Default environment is `node` — add `// @vitest-environment jsdom` at the top of a `.tsx` test that needs a DOM. Both configs alias `src` → `apps/web/src`.

The Apple app has XCTest coverage in `apps/mac/UnstreamTests/`; the Xcode project is generated from `apps/mac/project.yml` (XcodeGen), so edit that rather than the `.xcodeproj`.

## Deployment

Pushes to `main` trigger Netlify builds (`npm run build`). Functions deploy from `api/functions/`, edge functions from `api/edge/`. Edge routes, `/api/*` redirects, and security headers/CSP are configured in `netlify.toml`.

GitHub Actions (`.github/workflows/`):

- `supabase-migrate.yml` — auto-applies new migrations on push to `main`.
- `schedule-social-posts.yml` — weekly (Mondays) social post generation, committed back to the repo.
- `semantic-revert-check.yml` — runs `scripts/semantic-revert-check.py` on every PR to flag changes that quietly undo earlier fixes. If it flags your PR, take it seriously: the bug loops it was built for are described in `docs/retros/UNS-100-bifurcation-retro.md`.

## Engineering principles

Default to **simple, boring code that a human can read once and understand.** The owner is not an engineer and reviews at the product level, so the codebase has to stay legible to whoever (human or agent) touches it next. When in doubt, choose the more obvious option over the clever one.

- **Boring beats clever.** Prefer plain, explicit code over abstraction, metaprogramming, or "smart" one-liners. Don't add layers, generics, or config flags for flexibility nobody has asked for. Solve the problem in front of you.
- **Match the surrounding code.** Follow the naming, structure, and idioms already in the file/module. Consistency matters more than personal preference. Reuse existing helpers (e.g. `api/functions/middleware.ts`, `api/functions/cache.ts`, `api/shared/platform-registry.ts`, `apps/web/src/services/*`) instead of reinventing them.
- **Small, focused units.** Keep functions and components short and single-purpose — see how `ResultCard*` and `Claim*Step` are split, and how pure search logic was pulled out into `search-utils.ts` / `search-parsers.ts`. If a file is growing a second responsibility, split it.
- **Name things for what they do.** Clear names and a short comment for non-obvious *why* beat dense code with no explanation. Don't comment the obvious. The comments explaining *why* an approach was abandoned (blocked endpoints, removed allowlist hosts, cache-collision fixes) are load-bearing — keep them current instead of deleting them.
- **No dead weight.** Don't leave commented-out code, unused exports, speculative "might need later" branches, or TODOs without follow-through. Delete what isn't used.
- **Scale through clarity, not premature optimization.** Write the straightforward version first; optimize only with a concrete reason (a real hot path, a measured cost). Note the trade-off when you do.
- **Fail loudly and handle errors explicitly.** Validate inputs at boundaries, surface errors (Sentry is wired up — use it), and avoid silent catches that swallow problems. A scraper that returns an empty array on a bot challenge is a silent failure: report it.
- **Never cache uncertainty.** A failed lookup is not a negative result. See the section above — this is the single most repeated bug class in this codebase.
- **One route, one renderer.** If a URL is server-rendered by an edge function, it is not also client-rendered by the SPA. Pick one. The "two renderers for one URL" pattern causes back-button / bfcache breakage and creates bug loops where every fix is a partial revert of the previous fix. See `docs/retros/UNS-100-bifurcation-retro.md` for the full lesson (UNS-70/71/73/94/97/99/100 series). When you need both SEO/no-JS HTML *and* React interactivity, use a pure-SSR edge function as the no-JS/crawler fallback and the SPA as the in-app renderer, and ensure the SPA never tries to "take over" from the static response. (`/u/:handle` is the reference implementation: edge renders, React hydrates only a Copy URL button.)
- **Respect other people's servers.** Check `robots.txt` before adding a scrape, and honor it — several outages here were self-inflicted by scraping disallowed paths. Prefer documented APIs, directories, and sitemaps; cache aggressively so repeat queries cost one DB read instead of one fetch.

### Security practices

Treat security as part of "done," not a later pass. Flag anything you can't fully resolve rather than leaving it silent.

- **Validate and sanitize all external input** at the boundary — query params, request bodies, URL params, webhook payloads. Never trust client-supplied data. Escape anything interpolated into edge-function HTML (`escapeHtml`); `api/functions/__tests__/xss-defense.test.ts` guards this.
- **SSRF protection is mandatory** for any code that fetches an external URL (resolver, enrichment, probe, embed paths). Route outbound fetches through `isUrlHostnameAllowed()` and add new hosts to `ALLOWED_OUTBOUND_HOSTNAMES`; don't add a raw `fetch(userUrl)`.
- **Respect the CORS/auth model.** Public endpoints stay restricted to `unstream.stream`; API-key requests get permissive CORS because the key is the authorization. Use the shared middleware rather than hand-rolling headers.
- **RLS on every table.** New Supabase tables/columns ship with RLS policies in a migration. Server-only tables ship with RLS enabled and no policies, plus a comment saying that's deliberate. Never rely on client-side checks alone for authorization.
- **No secrets in code or logs.** Use environment variables. Don't log API keys, tokens, magic-link codes, or personal data. API keys are stored hashed, not in plaintext — keep it that way. Cache keys derived from user input should hold normalized search terms, not PII.
- **Verify signed/authenticated requests** where the pattern exists (e.g. Discord interaction signature verification with tweetnacl). Don't bypass it for convenience.
- **Keep CSP and security headers intact.** When touching `netlify.toml`, don't loosen CSP or headers without a clear reason; explain any change.
- **Least privilege.** Check admin/ownership before privileged actions (merges, verification, profile edits, username claims) on the server, not just in the UI.

## Working with the project owner

The project owner is a highly experienced product manager with deep familiarity with web technologies, product strategy, UX, and the alternative music platform ecosystem. He can provide detailed product requirements, evaluate trade-offs, review UI/UX decisions, and navigate the codebase at a conceptual level.

He is not a software engineer, security engineer, or infrastructure engineer. Claude Code sessions should:

- **Write production-ready code directly** rather than providing snippets to implement. Don't assume he can fill in gaps, wire things up, or debug build/runtime errors on his own.
- **Handle security concerns proactively** — CSP headers, RLS policies, input validation, SSRF protection, auth edge cases. Flag security issues clearly rather than expecting them to be caught in review.
- **Manage infrastructure details** — Netlify config, Supabase migrations, edge function routing, environment variables, deployment issues. Explain what changed and why when touching these areas.
- **Explain technical trade-offs in product terms** — frame decisions around user impact, maintenance burden, and complexity rather than pure implementation details.
- **Run tests and lint before considering work done.** Don't leave broken builds for him to debug.
