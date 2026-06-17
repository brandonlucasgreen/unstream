# Unstream - Development Guide

## Project overview

Unstream helps music listeners find their favorite artists on alternative platforms outside streaming, so they can support artists directly. It searches ~17 platforms (Bandcamp, Mirlo, Ampwall, Qobuz, Beatport, Faircamp, Patreon, etc.) and shows verified links grouped by category with artist payout percentages. On Bandcamp Fridays, results highlight the platforms that pay artists 100%.

The product runs at [unstream.stream](https://unstream.stream).

## Architecture

- **Frontend**: React 19 SPA with React Router 7, Tailwind CSS v4, Vite 7, TypeScript. PWA-enabled (`vite-plugin-pwa`).
- **Backend**: Netlify Functions (serverless API, `api/functions/`) + Edge Functions (SSR/OG metadata, `api/edge/`). Functions are TypeScript; edge functions run on Deno (see `deno.lock`).
- **Database**: Supabase (Postgres with RLS) for artist profiles, analytics, merge overrides, API keys, verification requests, and saved/supported artists.
- **Data enrichment**: MusicBrainz, Wikidata, Bandcamp API.
- **Rate limiting**: Upstash Redis (`@upstash/ratelimit`).
- **Error monitoring**: Sentry — `@sentry/react` on the web app (`apps/web/src/services/sentry.ts`), `@sentry/node` in functions (`api/lib/sentry.ts`). Source maps uploaded via `npm run sentry:sourcemaps`.
- **Analytics**: GoatCounter (public) + custom Supabase analytics (artist dashboard).
- **Integrations**: Public REST API (v1), Discord slash-command bot, weekly RSS "Dispatch", social post automation.
- **Hosting**: Netlify.

## Repository structure

```
unstream/
├── apps/
│   ├── web/                    # React + Vite SPA
│   │   ├── src/
│   │   │   ├── components/     # Shared UI (ResultCard*, Claim* steps, Header, SearchBar, …)
│   │   │   ├── pages/          # Route page components
│   │   │   ├── services/       # API clients, sources config, analytics, auth, sentry
│   │   │   ├── contexts/       # AuthContext (Supabase auth)
│   │   │   ├── hooks/          # usePWA, useTheme
│   │   │   ├── data/           # FAQ content, static data
│   │   │   ├── types/          # TypeScript interfaces
│   │   │   └── utils/          # Markdown renderer, colors, bandcamp-friday helpers
│   │   ├── public/             # Static assets + generated dispatch.xml, sitemap
│   │   └── tests/              # Unit + integration tests (Vitest), fixtures
│   ├── mac/                    # Universal Apple app (macOS menu bar + iOS), SwiftUI
│   │   └── Unstream/
│   │       ├── Views/          # macOS / iOS / Shared SwiftUI views
│   │       ├── Services/       # Release checkers (Bandcamp, Mirlo, Qobuz, Faircamp)
│   │       ├── Platform/       # Media observer, hotkey, scrobbling, updates
│   │       ├── StoreKit/       # In-app support purchases
│   │       └── Models/         # AppState, NowPlaying, ReleaseAlert, etc.
│   └── extension/              # Browser extension (Chrome + Firefox)
│       ├── content/            # Content scripts per streaming site
│       ├── popup/              # Extension popup UI
│       ├── background/         # Service worker
│       └── manifest.json / manifest-firefox.json
├── api/
│   ├── functions/              # Netlify serverless functions (search, auth, analytics, admin, API v1, Discord, embeds)
│   ├── edge/                   # Edge functions (OG metadata, artist/claimed-artist/guide/directory SSR, noscript search)
│   ├── search/                 # Search modules (Bandcamp, MusicBrainz, site-search, sources, enrichment)
│   ├── embed/                  # Bandcamp embed resolver
│   ├── shared/                 # platform-registry.ts (canonical platform list + categories + payouts)
│   ├── lib/                    # sentry.ts (function instrumentation)
│   └── scripts/                # sentry-test.ts and other function-side scripts
├── scripts/                    # Data generation + ops (artists, data, sitemap, social, guides manifest,
│                               #   dispatch feed, bandcamp date sync, discord command registration)
├── data/
│   ├── artists/                # Pre-generated artist SEO JSON
│   ├── guides/                 # Markdown guide posts with frontmatter
│   ├── dispatch/               # Weekly "Dispatch" markdown entries + PROMPT.md (see Dispatch below)
│   ├── social-posts/           # Generated/scheduled social post history
│   ├── artist-list.json        # Wikidata-sourced artist list
│   └── shipped-features.json   # Changelog/roadmap data
├── supabase/                   # schema.sql + numbered migration-NNN-*.sql files
├── docs/                       # Specs, content drafts, OpenAPI spec, product/architecture docs
└── netlify.toml                # Edge function routes, /api/* redirects, headers/CSP
```

## Commands

```bash
npm install               # Install dependencies
npm run dev               # Start Vite dev server (apps/web)
npm run build             # Full build: guides manifest + dispatch feed + typecheck + unit tests + Vite build + sitemap
npm run test              # Run all tests (unit + integration)
npm run test:unit         # Unit tests only (run in build pipeline)
npm run test:integration  # Integration tests only
npm run lint              # ESLint (apps/web)
npm run generate:artists  # Fetch artist list from Wikidata
npm run generate:data     # Generate artist page JSON via APIs
npm run generate:social   # Generate social media posts via Buffer
npm run sync:bandcamp-dates # Sync Bandcamp release dates
npm run sentry:sourcemaps   # Upload source maps to Sentry
```

Run `npm run build` (or at least `npm run lint` + `npm run test:unit`) before considering work done — unit tests and typechecking are part of the build pipeline and a failure blocks the Netlify deploy.

## Key patterns

### Search flow
Two-phase. Phase 1 calls `/api/search/sources` for fast results from all platforms (~1-2s); Phase 2 enriches with MusicBrainz data (official sites, social profiles, release verification) in the background. Multi-artist queries (e.g. "Artist feat. Artist2") are split, searched in parallel, then merged and deduplicated. Search modules live in `api/search/`; the function entrypoints are `search-sources.ts` / `search-musicbrainz.ts` (with `*-v1.ts` public-API variants).

### Platform registry
`api/shared/platform-registry.ts` is the single source of truth for supported platforms, their categories (marketplace, patronage, decentralized, library, official, social), and payout percentages. Add or change platforms there rather than hardcoding elsewhere. The web app mirrors presentation config in `apps/web/src/services/sources.ts`.

### Artist profiles
Artists claim profiles via `/claim/:slug` (email magic link or password auth, with a manual-review fallback path). The claim flow is a multi-step wizard split across `Claim*Step.tsx` components. Claimed profiles are edited at `/artist-edit/:slug` (bio, photo, links, location, featured release embed). Artist pages (both claimed and unclaimed) render at `/a/:slug` and `/artist/:slug` via the `artist-page-static` edge function. Analytics (searches, views, clicks) appear on the artist dashboard.

### Saved & supported artists
Signed-in fans can save artists and mark artists as supported (migrations 013–015). Backed by `saved-artists.ts` function and surfaced in the dashboard / app clients.

### Public API (v1)
A versioned REST API for third parties, documented in `docs/openapi.yaml` and surfaced on the `/developers` page. Endpoints: `artist-lookup-v1`, `resolve-url-v1`, `search-sources-v1`, plus `api-key-generate` and `api-status`. API keys are stored hashed in Supabase (migration 007); requests carrying a key get permissive CORS, anonymous requests are restricted to `unstream.stream`. See `api/functions/middleware.ts`.

### Discord bot
Slash-command bot: `discord-interaction.ts` verifies signatures (tweetnacl) and dispatches to `discord-search-background.ts` for async search responses. Commands are registered with `scripts/discord-register-commands.ts`.

### Edge functions (SSR/SEO)
Edge functions in `api/edge/` handle SSR for SEO, routed in `netlify.toml`: `og-metadata` (`/`), `artist-page-static` (`/artist/*` and `/a/*`), `guide-page` (`/guides/*`), `noscript-search` (`/search`). (`/artists` is SPA-only after UNS-98; the `artist-directory-page` edge function was removed.)

### Guides
Markdown files in `data/guides/` with YAML frontmatter (title, description, pillar, published/draft). A manifest is generated at build time (`scripts/generate-guides-manifest.ts`). Pillars: artist-economics, platform-discovery, how-to, builder.

### The Dispatch
A weekly music-industry briefing published as an RSS feed at `/dispatch.xml`. Entries are markdown files at `data/dispatch/YYYY-Www.md`; `scripts/generate-dispatch-feed.ts` regenerates the feed at build time. **Important:** per `data/dispatch/README.md` and `PROMPT.md`, dispatch work is committed **directly to `main`**, not via branches or PRs — this overrides any default development-branch assignment for dispatch tasks only.

### Admin tools
Admin users (checked by email) can merge duplicate search results via `/admin/merge` and review verification requests via `/admin/verify`. Merge overrides are stored in Supabase (migrations 004–005) and respected during search disambiguation. There is also an `/admin/analytics` view.

### API middleware & security
`api/functions/middleware.ts` centralizes CORS, authentication, query validation, and SSRF protection. SSRF guards matter because the resolver/enrichment paths fetch external URLs — keep new outbound-fetch code behind those guards. Sentry is wired in via `api/lib/sentry.ts`; some events are rate-limited to prevent spam.

## Auth

Supabase Auth with magic links and password sign-in. Auth state is managed via `AuthContext` (`apps/web/src/contexts/`). Admin status is checked against the user's email. RLS policies protect all database tables — add/adjust policies in a numbered migration when introducing new tables or columns.

## Database / migrations

Schema lives in `supabase/schema.sql`; changes are applied as numbered `migration-NNN-*.sql` files (currently through 015). When adding a table or column, write a new migration file, include RLS policies, and explain the change. Don't edit historical migrations.

## Testing

Tests use Vitest. Unit tests are in `apps/web/tests/unit/`, integration tests in `apps/web/tests/integration/`, fixtures in `apps/web/tests/fixtures/`. Unit tests run as part of the build pipeline; integration tests (e.g. search accuracy) are run separately.

## Deployment

Pushes to `main` trigger Netlify builds. The build command generates the guides manifest and dispatch feed, runs typechecking and unit tests, builds the Vite app, and generates the sitemap. Functions deploy from `api/functions/`, edge functions from `api/edge/`. Edge routes, `/api/*` redirects, and security headers/CSP are configured in `netlify.toml`. GitHub Actions (`.github/workflows/`) handle scheduled social posts and a semantic-revert check.

## Engineering principles

Default to **simple, boring code that a human can read once and understand.** The owner is not an engineer and reviews at the product level, so the codebase has to stay legible to whoever (human or agent) touches it next. When in doubt, choose the more obvious option over the clever one.

- **Boring beats clever.** Prefer plain, explicit code over abstraction, metaprogramming, or "smart" one-liners. Don't add layers, generics, or config flags for flexibility nobody has asked for. Solve the problem in front of you.
- **Match the surrounding code.** Follow the naming, structure, and idioms already in the file/module. Consistency matters more than personal preference. Reuse existing helpers (e.g. `api/functions/middleware.ts`, `api/shared/platform-registry.ts`, `apps/web/src/services/*`) instead of reinventing them.
- **Small, focused units.** Keep functions and components short and single-purpose — see how `ResultCard*` and `Claim*Step` are split. If a file is growing a second responsibility, split it.
- **Name things for what they do.** Clear names and a short comment for non-obvious *why* beat dense code with no explanation. Don't comment the obvious.
- **No dead weight.** Don't leave commented-out code, unused exports, speculative "might need later" branches, or TODOs without follow-through. Delete what isn't used.
- **Scale through clarity, not premature optimization.** Write the straightforward version first; optimize only with a concrete reason (a real hot path, a measured cost). Note the trade-off when you do.
- **Fail loudly and handle errors explicitly.** Validate inputs at boundaries, surface errors (Sentry is wired up — use it), and avoid silent catches that swallow problems.

### Security practices

Treat security as part of "done," not a later pass. Flag anything you can't fully resolve rather than leaving it silent.

- **Validate and sanitize all external input** at the boundary — query params, request bodies, URL params, webhook payloads. Never trust client-supplied data.
- **SSRF protection is mandatory** for any code that fetches an external URL (resolver, enrichment, embed paths). Route outbound fetches through the existing SSRF guards in `api/functions/middleware.ts`; don't add a raw `fetch(userUrl)`.
- **Respect the CORS/auth model.** Public endpoints stay restricted to `unstream.stream`; API-key requests get permissive CORS because the key is the authorization. Use the shared middleware rather than hand-rolling headers.
- **RLS on every table.** New Supabase tables/columns ship with RLS policies in a numbered migration. Never rely on client-side checks alone for authorization.
- **No secrets in code or logs.** Use environment variables. Don't log API keys, tokens, magic-link codes, or personal data. API keys are stored hashed, not in plaintext — keep it that way.
- **Verify signed/authenticated requests** where the pattern exists (e.g. Discord interaction signature verification with tweetnacl). Don't bypass it for convenience.
- **Keep CSP and security headers intact.** When touching `netlify.toml`, don't loosen CSP or headers without a clear reason; explain any change.
- **Least privilege.** Check admin/ownership before privileged actions (merges, verification, profile edits) on the server, not just in the UI.

## Working with the project owner

The project owner is a highly experienced product manager with deep familiarity with web technologies, product strategy, UX, and the alternative music platform ecosystem. He can provide detailed product requirements, evaluate trade-offs, review UI/UX decisions, and navigate the codebase at a conceptual level.

He is not a software engineer, security engineer, or infrastructure engineer. Claude Code sessions should:

- **Write production-ready code directly** rather than providing snippets to implement. Don't assume he can fill in gaps, wire things up, or debug build/runtime errors on his own.
- **Handle security concerns proactively** — CSP headers, RLS policies, input validation, SSRF protection, auth edge cases. Flag security issues clearly rather than expecting them to be caught in review.
- **Manage infrastructure details** — Netlify config, Supabase migrations, edge function routing, environment variables, deployment issues. Explain what changed and why when touching these areas.
- **Explain technical trade-offs in product terms** — frame decisions around user impact, maintenance burden, and complexity rather than pure implementation details.
- **Run tests and lint before considering work done.** Don't leave broken builds for him to debug.
