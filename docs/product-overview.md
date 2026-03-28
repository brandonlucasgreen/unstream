# Unstream - Product Overview

## What Unstream is

Unstream is a free, open-source tool that helps music listeners find their favorite artists on platforms outside the streaming ecosystem and support them directly. It searches over 23 alternative platforms — music marketplaces, patronage sites, decentralized platforms, and library services — and presents verified links with artist payout percentages so users can make informed decisions about where their money goes.

The product lives at [unstream.stream](https://unstream.stream) and is available as a web app, macOS menu bar app, iOS app, Chrome extension, Firefox extension, and iOS Shortcut.

## Why Unstream exists

Unstream was built by a musician who experienced firsthand how the streaming model fails independent artists. The core problems with streaming:

1. **Tiny artist payouts.** A fraction of your subscription goes to artists, and you have no control over which ones. The economics disproportionately benefit major-label artists with hundreds of thousands of monthly listeners.

2. **No direct relationship.** Streaming platforms sit between you and the artist. You can't buy their music, own it, or support them meaningfully.

3. **Algorithm-driven discovery.** Streaming incentivizes passive consumption through algorithms rather than intentional curation. AI-generated music floods these platforms to exploit payout models.

4. **Platform lock-in.** Years of playlists and listening history make it feel impossible to leave, even when you want to.

Unstream's thesis: alternative platforms already exist where artists earn 80-97% of each sale (vs. fractions of a penny per stream), and most of your favorite artists are already on them — you just don't know it yet. Unstream bridges that gap.

The product serves two audiences:
- **Listeners** who want to support artists more directly, build their own music libraries, and reduce dependency on streaming
- **Artists** who want fans to discover them on platforms where they earn more, and who want to build direct relationships with their audience

## Core user flows

### 1. Search and discover

The primary flow. A user visits unstream.stream, types an artist name, and gets results.

**How search works under the hood:**

1. **Query parsing.** Multi-artist queries (e.g. "Artist feat. Artist2", "Artist & Artist2") are detected and split. Each artist is searched separately, plus the full query is searched as-is (to catch bands with conjunctions in their name like "Daryl Hall & John Oates").

2. **Phase 1 — Fast platform search (~1-2 seconds).** The `/api/search/sources` function queries multiple platforms in parallel:
   - **Bandcamp** — Direct API search via `bandcamp-fetch`
   - **MusicBrainz** — Artist lookup with URL relationships
   - **Site search** — DuckDuckGo-based search for platforms without APIs (Mirlo, Faircamp webring, Patreon, etc.)

   Results are grouped by artist, deduplicated by normalized name, and scored by text match relevance. Each result includes platform links, images (when available), and match confidence.

3. **Phase 2 — MusicBrainz enrichment (background).** After initial results display, a second call fetches detailed MusicBrainz data: official websites, social media profiles (Instagram, Facebook, YouTube, TikTok, Threads, Bluesky, Mastodon), and release verification. These are merged into existing results without a loading state change.

4. **Disambiguation and merge overrides.** When the same artist appears as multiple results (e.g. a Bandcamp result and a separate MusicBrainz result), the system attempts to merge them. Admin-defined merge overrides in Supabase can force specific results to be combined, preventing false splits.

5. **Result display.** Results appear as cards grouped by artist, with platforms organized into categories (Marketplaces, Patronage, Decentralized, Library, Official, Social). Each platform link shows the source name, icon, and (where available) artist payout percentage. Claimed/verified profiles show a badge and custom profile data.

**URL resolution.** Users can also paste a Spotify or Apple Music link (via `?url=` param). The `/api/resolve/url` function extracts the artist name from the streaming service URL and triggers a normal search.

**Shareable URLs.** Every search updates the URL to `?q=artist+name`, making results shareable.

### 2. Artist pages (SEO)

Pre-generated artist pages exist at `/artist/:slug` for ~800 artists sourced from Wikidata. These pages:
- Load pre-generated JSON data first (instant), falling back to live search
- Have SSR via edge functions for proper OG metadata (title, description)
- Are indexed in the sitemap for search engine discovery
- Track page views via custom analytics

The artist list is generated from Wikidata queries, filtered through MusicBrainz release cross-referencing to remove false matches, and maintained via a blocklist.

### 3. Artist claim and verification

Artists can claim their Unstream profile through a multi-step flow at `/claim/:slug`:

1. **Authentication.** Enter email to receive a magic link, or sign in with password if they have an account.
2. **Website verification.** Provide their official website URL. The system verifies the domain.
3. **Link review.** Review all discovered platform links. Toggle which ones to include. The system can scrape avatars from supported platforms (Bandcamp, YouTube, Mirlo).
4. **Profile customization.** Add/edit bio, profile photo URL, and featured release embed.
5. **Completion.** Profile is saved to Supabase. A verified badge appears on search results.

Claimed profiles get a short URL at `/a/:slug` with dedicated SSR edge function.

### 4. Artist dashboard

Authenticated artists access their dashboard at `/artist-dashboard`:

- **Profile management.** View all claimed profiles, navigate to edit pages.
- **Analytics.** View search appearances, page views, and outbound link clicks by platform over 7d/30d/90d/all-time periods. Analytics data comes from a Supabase RPC function using `SECURITY DEFINER` to bypass RLS for aggregation.
- **Profile editing.** At `/artist-edit/:slug`: edit bio, photo, links (add/remove/reorder), featured release embed. Streaming service URLs trigger soft warnings encouraging direct-support platforms instead. Platform links are validated and categorized.
- **Password management.** Set or update account password (alongside magic link auth).

### 5. Guides (content/blog)

Unstream publishes educational guides at `/guides`:

- **Content storage.** Markdown files with YAML frontmatter in `data/guides/`. Fields: title, description, pillar, published date, draft flag.
- **Pillars.** Content is organized into: Artist economics, Platform discovery, How-to for fans, Builder/open source.
- **Build pipeline.** A manifest (`guides-manifest.json`) is generated at build time from the markdown files. Only published (non-draft) guides are included.
- **SSR.** Edge functions serve proper OG metadata for guide pages.
- **Current guides:** "Where Your Money Goes: Streaming vs. Buying", "Bandcamp Friday Explained", "How to Build a Music Library Without Streaming", "The Real Cost of Free Music", "Bandcamp and Beyond: Alternative Music Platforms Worth Knowing", "Why I Built Unstream".

### 6. Admin tools

Admin users (identified by email in AuthContext) have access to:

- **Merge override UI** (`/admin/merge`). When search results return duplicate entries for the same artist (e.g. separate Bandcamp and MusicBrainz matches), admins can select multiple results from the search page, navigate to the merge UI, review/toggle individual platform links, choose a canonical name, and save. The override is stored in Supabase and applied during future searches to prevent the same duplicates from reappearing.

- **Result selection.** On the main search page, admin users see checkboxes on result cards. Selecting 2+ results shows a floating "Merge Artists" button.

## Platform apps

### macOS menu bar app

A native SwiftUI app that lives in the macOS menu bar:

- **Now Playing detection.** Monitors Spotify, Apple Music, and other media players via macOS media APIs. Detects the currently playing artist and shows a popover with support options.
- **Search.** Manual artist search within the popover.
- **Support list.** Save artists you want to support later. Persisted locally.
- **Release alerts.** Checks Bandcamp, Mirlo, Qobuz, and Faircamp for new releases from saved artists. Shows macOS notifications for new music.
- **ListenBrainz scrobbling.** Optionally scrobble plays to ListenBrainz (open-source Last.fm alternative).
- **Global keyboard shortcut.** Configurable hotkey to open/close the popover.
- **Share card.** Share what you're currently listening to with a styled card.
- **Auto-updates.** Checks for new versions via `/api/desktop/version`.
- **Tip jar.** In-app StoreKit tips to support development.
- **Analytics.** GoatCounter tracking for app events.

### iOS app

Universal Apple app sharing code with macOS:

- **Search tab.** Search for artists and view results.
- **Support list tab.** Saved artists with support options.
- **Releases tab.** New release alerts from saved artists.
- **Settings tab.** App configuration.

### Browser extension (Chrome + Firefox)

Detects music playback across streaming sites and shows Unstream results:

- **Content scripts** for: Spotify, Apple Music, YouTube, YouTube Music, SoundCloud, Bandcamp, plus a generic fallback.
- **Popup UI.** Shows the detected artist with links to their Unstream results.
- **Bandcamp Friday awareness.** Highlights when it's Bandcamp Friday.
- **Manifest V3** (Chrome) and **Manifest V2** (Firefox) variants.

### iOS Shortcut

A Siri Shortcut that accepts shared links from Spotify or Apple Music and opens the corresponding Unstream search.

## Technical infrastructure

### API endpoints

All API routes are Netlify Functions proxied via `netlify.toml` redirects:

| Endpoint | Function | Purpose |
|---|---|---|
| `/api/search/sources` | `search-sources` | Primary multi-platform search |
| `/api/search/musicbrainz` | `search-musicbrainz` | MusicBrainz enrichment data |
| `/api/embed/bandcamp` | `embed-bandcamp` | Resolve Bandcamp embed URLs |
| `/api/resolve/url` | `resolve-url` | Extract artist from Spotify/Apple Music URLs |
| `/api/artist` | `artist-lookup` | Look up artist by slug |
| `/api/claim` | `claim-artist` | Artist profile claim flow |
| `/api/artist-auth` | `artist-auth` | Auth status and profile list |
| `/api/artist-profile` | `artist-profile` | Read/update artist profile data |
| `/api/artist-directory` | `artist-directory` | List all claimed artists |
| `/api/desktop/version` | `desktop-version` | Mac app version check |
| `/api/analytics/event` | `analytics-event` | Track analytics events |
| `/api/analytics/stats` | `analytics-stats` | Artist analytics dashboard data |
| `/api/admin/merge-override` | `admin-merge-override` | Save/read merge overrides |

### Edge functions

| Path | Function | Purpose |
|---|---|---|
| `/` | `og-metadata` | Homepage OG tags |
| `/artist/*` | `artist-page` | Pre-generated artist page OG tags |
| `/a/*` | `claimed-artist-page` | Claimed artist profile OG tags |
| `/artists` | `artist-directory-page` | Artist directory OG tags |
| `/guides/*` | `guide-page` | Guide page OG tags |

### Database (Supabase)

Tables include:
- **Artist profiles** — claimed artist data (name, slug, bio, image, links, embed URL, website)
- **Analytics events** — search appearances, page views, link clicks per artist
- **Merge overrides** — admin-defined artist result merges
- **Auth** — Supabase Auth handles user accounts (magic link + password)

All tables use Row Level Security (RLS). Analytics aggregation uses a `SECURITY DEFINER` RPC function to bypass RLS for read-only stats.

### Data generation pipeline

1. **Artist list** (`generate:artists`). Queries Wikidata for notable musicians, cross-references with MusicBrainz releases to filter false matches, maintains a blocklist, outputs a manifest.
2. **Artist data** (`generate:data`). For each artist in the manifest, runs the search pipeline and saves results as static JSON in `data/artists/`. Includes rate limiting and retry logic.
3. **Sitemap** (`generate-sitemap.ts`). Generates `public/sitemap.xml` from the artist manifest + static pages. Runs as part of the build.
4. **Guides manifest** (`generate-guides-manifest.ts`). Parses frontmatter from `data/guides/*.md`, filters out drafts, outputs `data/guides/guides-manifest.json`. Runs at build start.
5. **Social posts** (`generate:social`). Generates featured artist social media posts and schedules them via Buffer.

### Rate limiting

Upstash Redis-based rate limiting protects API endpoints from abuse.

### Content Security Policy

Configured in `netlify.toml` headers. Allows: GoatCounter analytics, Letterbird contact form, Supabase connections, Google Fonts, and HTTPS image/frame sources.

## Pages and routes

| Route | Page | Auth required | Description |
|---|---|---|---|
| `/` | App (homepage) | No | Search, results, FAQ, app promo, contact form |
| `/artist/:slug` | ArtistPage | No | Pre-generated artist page with search fallback |
| `/a/:slug` | ArtistPage | No | Short URL for claimed artist profiles |
| `/artists` | ArtistDirectoryPage | No | Directory of all verified artists |
| `/claim/:slug` | ClaimPage | Yes (during flow) | Multi-step artist profile claim |
| `/artist-login` | ArtistLoginPage | No | Magic link + password login |
| `/reset-password` | ResetPasswordPage | No | Password reset flow |
| `/artist-dashboard` | ArtistDashboardPage | Yes | Artist's profile list + analytics |
| `/artist-edit/:slug` | ArtistEditPage | Yes | Edit artist profile, links, bio, photo |
| `/guides` | GuidesIndexPage | No | Guide listing by pillar |
| `/guides/:slug` | GuidePage | No | Individual guide article |
| `/roadmap` | RoadmapPage | No | Embedded FeatureBase roadmap |
| `/support` | SupportPage | No | Donation via Liberapay + other ways to help |
| `/privacy-policy` | PrivacyPolicyPage | No | Privacy policy |
| `/admin/merge` | AdminMergePage | Yes (admin) | Merge duplicate artist results |

## Supported platforms

### Music marketplaces (buy/own music)
| Platform | Payout to artist |
|---|---|
| Bandcamp | 80-85% |
| Mirlo | 86-90% |
| Ampwall | 92-95% |
| Qobuz | ~70% |
| Jam.coop | Cooperative model |
| Discogs | Varies (marketplace) |

### Patronage (recurring support)
| Platform | Payout to artist |
|---|---|
| Patreon | 86-90% |
| Buy Me a Coffee | ~92% |
| Ko-fi | 92-97% |

### Decentralized / community
- **Bandwagon** — ActivityPub-based music community
- **Faircamp** — Self-hosted static music sites (90-97%)

### Library services (free via library card)
- **Hoopla** — Library streaming
- **Freegal** — Library music streaming

### Social and official
- Official websites (via MusicBrainz)
- Instagram, Facebook, TikTok, YouTube, Threads, Bluesky, Mastodon, PeerTube

## Values and principles

- **Free forever.** Unstream is free because the point is getting money to artists, not charging users to find them. Supported by optional donations via Liberapay.
- **No AI in the product.** The app neither uses AI models to recommend artists nor promotes AI-generated music.
- **Privacy-first.** GoatCounter for public, privacy-friendly analytics. No personal data captured from visitors. No tracking pixels or ad networks.
- **Open source.** The entire codebase is public on GitHub.
- **Artist-first.** Platform links are ordered and highlighted by artist payout percentage. Streaming service links on artist edit pages trigger warnings encouraging direct-support alternatives.
