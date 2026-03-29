# Unstream - Development Guide

## Project overview

Unstream helps music listeners find their favorite artists on alternative platforms outside streaming, so they can support artists directly. It searches 15 platforms (Bandcamp, Mirlo, Ampwall, Qobuz, Faircamp, Patreon, etc.) and shows verified links grouped by category with artist payout percentages.

The product runs at [unstream.stream](https://unstream.stream).

## Architecture

- **Frontend**: React 19 SPA with React Router, Tailwind CSS v4, Vite, TypeScript
- **Backend**: Netlify Functions (serverless API) + Edge Functions (SSR/OG metadata)
- **Database**: Supabase (Postgres with RLS) for artist profiles, analytics, merge overrides
- **Data enrichment**: MusicBrainz, Wikidata, Bandcamp API
- **Rate limiting**: Upstash Redis
- **Analytics**: GoatCounter (public) + custom Supabase analytics (artist dashboard)
- **Hosting**: Netlify

## Repository structure

```
unstream/
├── apps/
│   ├── web/                    # React + Vite SPA
│   │   ├── src/
│   │   │   ├── components/     # Shared UI components
│   │   │   ├── pages/          # Route page components
│   │   │   ├── services/       # API clients, sources config, analytics
│   │   │   ├── contexts/       # AuthContext (Supabase auth)
│   │   │   ├── data/           # FAQ content, static data
│   │   │   ├── types/          # TypeScript interfaces
│   │   │   └── utils/          # Markdown renderer, helpers
│   │   └── tests/              # Unit and integration tests (Vitest)
│   ├── mac/                    # Universal Apple app (macOS menu bar + iOS)
│   │   └── Unstream/
│   │       ├── Views/macOS/    # macOS-specific views (popover, settings)
│   │       ├── Views/iOS/      # iOS-specific views (tabs, settings)
│   │       ├── Views/Shared/   # Shared SwiftUI components
│   │       ├── Services/       # Release checkers (Bandcamp, Mirlo, Qobuz, Faircamp)
│   │       ├── Platform/macOS/ # Media observer, hotkey, scrobbling, updates
│   │       └── Models/         # AppState, NowPlaying, ReleaseAlert, etc.
│   └── extension/              # Browser extension (Chrome + Firefox)
│       ├── content/            # Content scripts per streaming site
│       ├── popup/              # Extension popup UI
│       └── background/         # Service worker
├── api/
│   ├── functions/              # Netlify serverless functions (search, auth, analytics, etc.)
│   ├── edge/                   # Edge functions (OG metadata, artist page SSR)
│   ├── search/                 # Search modules (Bandcamp, MusicBrainz, site search)
│   └── embed/                  # Bandcamp embed resolver
├── scripts/                    # Data generation (artist list, artist data, sitemap, social posts, guides manifest)
├── data/
│   ├── artists/                # Pre-generated artist SEO JSON
│   └── guides/                 # Markdown guide posts with frontmatter
└── public/                     # Static assets
```

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Start Vite dev server (apps/web)
npm run build            # Full build: guides manifest + typecheck + unit tests + Vite build + sitemap
npm run test             # Run all tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run lint             # ESLint
npm run generate:artists # Fetch artist list from Wikidata
npm run generate:data    # Generate artist page JSON via APIs
npm run generate:social  # Generate social media posts via Buffer
```

## Key patterns

### Search flow
The search is two-phase: Phase 1 calls `/api/search/sources` for fast results from all platforms (~1-2s), then Phase 2 enriches with MusicBrainz data in the background. Multi-artist queries (e.g. "Artist feat. Artist2") are split and searched in parallel, then merged and deduplicated.

### Artist profiles
Artists claim profiles via `/claim/:slug` (email magic link or password auth). Claimed profiles can be edited at `/artist-edit/:slug` with custom bio, photo, links, and featured release embed. Analytics (searches, views, clicks) are shown on the artist dashboard.

### Admin tools
Admin users can merge duplicate search results via `/admin/merge`. Merge overrides are stored in Supabase and respected during search disambiguation.

### Edge functions
Edge functions handle SSR for SEO: OG metadata on the homepage, artist page meta tags, artist directory page, and guide pages.

### Guides
Markdown files in `data/guides/` with YAML frontmatter (title, description, pillar, published/draft). A manifest is generated at build time. Pillars: artist-economics, platform-discovery, how-to, builder.

## Auth

Supabase Auth with magic links and password sign-in. Auth state is managed via `AuthContext`. Admin status is checked against the user's email. RLS policies protect all database tables.

## Testing

Tests use Vitest. Unit tests are in `apps/web/tests/unit/`, integration tests in `apps/web/tests/integration/`. Unit tests run as part of the build pipeline.

## Deployment

Pushes to `main` trigger Netlify builds. The build command generates the guides manifest, runs typechecking and unit tests, builds the Vite app, and generates the sitemap. Functions deploy from `api/functions/`, edge functions from `api/edge/`.

## Working with the project owner

The project owner is a highly experienced product manager with deep familiarity with web technologies, product strategy, UX, and the alternative music platform ecosystem. He can provide detailed product requirements, evaluate trade-offs, review UI/UX decisions, and navigate the codebase at a conceptual level.

He is not a software engineer, security engineer, or infrastructure engineer. Claude Code sessions should:

- **Write production-ready code directly** rather than providing snippets to implement. Don't assume he can fill in gaps, wire things up, or debug build/runtime errors on his own.
- **Handle security concerns proactively** — CSP headers, RLS policies, input validation, SSRF protection, auth edge cases. Flag security issues clearly rather than expecting them to be caught in review.
- **Manage infrastructure details** — Netlify config, Supabase migrations, edge function routing, environment variables, deployment issues. Explain what changed and why when touching these areas.
- **Explain technical trade-offs in product terms** — frame decisions around user impact, maintenance burden, and complexity rather than pure implementation details.
- **Run tests and lint before considering work done.** Don't leave broken builds for him to debug.
