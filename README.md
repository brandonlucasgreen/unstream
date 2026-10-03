# Unstream

**Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.**

[unstream.stream](https://unstream.stream)

Unstream searches 17+ platforms to find where your favorite artists sell music, accept patronage, or share music for free outside the streaming ecosystem. It shows artist payout percentages so you can make informed choices about where your money goes.

## Mission, vision, and values

**Mission:** To deepen the connection between fans and artists so appreciation turns into lasting support.

**Vision:** A world where more people support the arts and where more artists are sustainably supported.

**Values:** Unwavering respect for artists · Patience · Curiosity · Transparency

**Operating principles:**

- Artists first, supporters second
- Build for connection, not just transaction
- Solve from first principles; don't be afraid to be scrappy
- No ego in the face of conflict

## How it works

Search for any artist, album, or track. Unstream checks platforms like Bandcamp, Mirlo, Faircamp, Patreon, Qobuz, and more, then shows you verified links grouped by category:

- **Music Marketplaces** - Buy music directly (Bandcamp, Mirlo, Ampwall, Qobuz, Jam.coop, Discogs)
- **Patronage** - Support artists directly (Patreon, Buy Me a Coffee, Ko-fi)
- **Decentralized** - Community alternatives (Bandwagon, Faircamp)
- **Library Services** - Free access through your library (Hoopla, Freegal)
- **Official & Social** - Artist websites, social links (Instagram, YouTube, Bluesky, Mastodon, Threads, and more)

Search uses a two-phase approach: fast platform results appear in ~1-2 seconds, then MusicBrainz enrichment adds official websites, social profiles, and release verification in the background. Multi-artist queries (e.g. "Artist feat. Artist2") are split, searched in parallel, and deduplicated. On Bandcamp Fridays, results highlight which platforms pay artists 100% of the purchase price.

## Artist profiles

Artists can claim and verify their Unstream profile to customize their page with a photo, bio, featured release embed, social links, and direct support options. Verified profiles appear in the [Artist Index](https://unstream.stream/artists).

Claimed artists get access to an analytics dashboard showing search appearances, page views, and link clicks by platform over configurable time periods.

To claim a profile, search for your artist name and click "Is this you?" on your result card. You'll sign in with an emailed link, then prove the profile is yours by adding a verification link to your website (or ask for a manual review).

## For fans

Sign in (free) to:

- **Save artists and track your support** — keep a list of artists you want to support, mark the ones you've bought from, and sync it with the Apple app.
- **Share your list** — claim a username to publish it at `unstream.stream/u/yourname`.
- **Get release alerts** — email when an artist you saved puts out something new, plus private calendar (.ics) and RSS feeds of upcoming releases.
- **Connect your Bandcamp collection** — import what you've bought, so your dashboard shows it alongside the artists you've saved.

## For developers

- **Public API** — search and artist lookup over REST. Docs at [unstream.stream/developers](https://unstream.stream/developers) (OpenAPI spec in [`docs/openapi.yaml`](docs/openapi.yaml)). Anonymous use is rate-limited; API keys are available, with the tiers on that page.
- **Discord bot** — search Unstream from a Discord server.

## Platforms

[unstream.stream/platforms](https://unstream.stream/platforms) lists every platform Unstream searches, grouped by how you support the artist, with the artist's payout on each. Payout sources are in the [FAQ](https://unstream.stream/faq).

## Apps

- **Web** - [unstream.stream](https://unstream.stream) (free, no account needed)
- **macOS menu bar app** - Detects what's playing in Spotify, Apple Music, or any browser-based player and shows support options. Includes a global keyboard shortcut, saved artist support list, release alerts for new music on Bandcamp, Mirlo, Faircamp and other stores, ListenBrainz scrobbling, and social sharing.
- **iOS app** - Search, support list, and release alerts on iPhone and iPad (universal Apple app).
- **Chrome extension** - [Chrome Web Store](https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf) - Detects playback on Spotify, Apple Music, YouTube, YouTube Music, SoundCloud, and Bandcamp, plus about 20 more players including Tidal, Deezer, Amazon Music, Qobuz, Audius, and Mixcloud.
- **Firefox extension** - [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/unstream/)
- **iOS Shortcut** - Share from Spotify or Apple Music to search on Unstream

All apps are free with no paywall. If Unstream is useful to you, you can [support its development](https://unstream.stream/support).

## Project structure

```
unstream/
├── apps/
│   ├── web/                # React + Vite web app (SPA)
│   │   ├── src/            # Components, pages, services, types
│   │   ├── public/         # Static assets (icons, robots.txt, generated sitemap and feeds)
│   │   └── tests/          # Unit and integration tests (Vitest)
│   ├── mac/                # Universal Apple app - macOS + iOS (SwiftUI)
│   └── extension/          # Browser extension (Chrome + Firefox)
├── api/
│   ├── functions/          # Serverless API: search, accounts, catalogue, alerts, admin, v1 API
│   ├── edge/               # Edge functions: release pages, crawler renders, link previews
│   ├── shared/             # Code shared by functions, edge functions and the web app
│   ├── lib/                # Email, Sentry, reserved usernames
│   └── search/             # Bandcamp probe and enrichment (the other files here are unused)
├── supabase/migrations/    # Database schema, applied automatically on merge
├── scripts/                # Data generation (artist list, artist data, sitemap, social posts, feeds)
├── data/
│   └── artists/            # Pre-generated artist SEO data (JSON)
└── docs/                   # Engineering history, specs, postmortems, OpenAPI spec
```

[`CLAUDE.md`](CLAUDE.md) is the detailed development guide: how search works, local-dev traps, and the rules behind the code.

## Development

```bash
npm install
npm run dev          # Full stack via `netlify dev` on :8888 (real functions, production data)
npm run dev:fast     # Vite only on :5173 — no API or sign-in; for CSS/layout work
npm run verify       # What CI runs: typecheck + API and web unit tests
npm run build        # Full build (feeds + sitemap + typecheck + Vite)
npm run lint         # Run ESLint (advisory; not in CI)
npm run test         # Web and API test suites
npm run test:unit    # Web unit tests only
npm run test:integration   # Search accuracy against live APIs (not in CI)
```

`npm run dev` talks to the **production** database, so saving an artist or changing settings locally changes real data. See "Local dev" in [`CLAUDE.md`](CLAUDE.md) before using it.

### Data generation

```bash
npm run generate:artists    # Fetch artist list from Wikidata
npm run generate:data       # Generate artist page data via APIs
npm run generate:social     # Generate social media posts
```

### Database migrations

Migration SQL files live in `supabase/migrations/` with timestamp-prefixed names (e.g. `20260628090000_drop-anon-policy.sql`). The older `supabase/migration-NNN-*.sql` files are historical copies kept for reference — new migrations should only be added to `supabase/migrations/`.

**Automatic deployment:** A GitHub Actions workflow (`.github/workflows/supabase-migrate.yml`) runs `supabase db push --linked` on every push to `main` that changes files under `supabase/migrations/`. Migrations are applied to the production Supabase project automatically — no manual SQL editor needed.

The workflow can also be triggered manually from the GitHub Actions tab ("Run workflow").

**Required GitHub secrets:**

- `SUPABASE_ACCESS_TOKEN` — Supabase CLI access token (`sbp_...` format)
- `SUPABASE_DB_PASSWORD` — Postgres password for the linked project

**If a migration fails:** the workflow shows red and maintainers get an email notification. Fix the migration in a follow-up PR — do not manually re-run it via the Supabase SQL editor.

**Local dry-run:**

```bash
npm run migrate:link       # Once, to link the Supabase CLI to the project
npm run migrate:dry-run    # Show what would be applied without touching the DB
npm run migrate:list       # List local vs remote migration state
```

When adding a new migration, create a file in `supabase/migrations/` named `YYYYMMDDHHMMSS_short_description.sql`. Use `IF NOT EXISTS` / `DROP ... IF EXISTS` guards so the migration is idempotent.

## Tech stack

- **Frontend**: React 19, React Router 7, Tailwind CSS v4, Vite 7, TypeScript (installable PWA)
- **Backend**: Netlify Functions (Node) + Edge Functions (Deno)
- **Database**: Supabase Postgres (artists, profiles, saved artists, releases, collections, analytics)
- **Auth**: Supabase Auth (magic links + password sign-in)
- **Caching & rate limiting**: Upstash Redis
- **Email**: Resend (release alerts, claim decisions); newsletter via Buttondown
- **Data**: MusicBrainz, Wikidata, Wikipedia, Discogs, Linktree, and each platform's public pages
- **Monitoring**: Sentry
- **Analytics**: GoatCounter (privacy-friendly, public) + custom artist analytics (Supabase)
- **Apple apps**: Swift, SwiftUI (universal macOS + iOS), updated with Sparkle on macOS
- **Browser extension**: Vanilla JS, Manifest V3 (Chrome and Firefox)

## Links

- [Roadmap](https://github.com/users/brandonlucasgreen/projects/4)
- [Public metrics](https://unstream.goatcounter.com)
- [Privacy policy](https://unstream.stream/privacy-policy)
- [Terms of use](https://unstream.stream/terms)
- [Support Unstream](https://unstream.stream/support)
