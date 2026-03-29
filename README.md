# Unstream

**Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.**

[unstream.stream](https://unstream.stream)

Unstream searches 15 platforms to find where your favorite artists sell music, accept patronage, or share music for free outside the streaming ecosystem. It shows artist payout percentages so you can make informed choices about where your money goes.

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

To claim a profile, search for your artist name and click "Is this you?" on your result card.

## Guides

Unstream publishes [guides](https://unstream.stream/guides) covering artist economics, platform discovery, and how-to content for fans. Topics include streaming payout breakdowns, Bandcamp Friday explained, how to build a music library without streaming, and more.

## Apps

- **Web** - [unstream.stream](https://unstream.stream) (free, no account needed)
- **macOS menu bar app** - Detects what's playing in Spotify, Apple Music, or any browser-based player and shows support options. Includes a global keyboard shortcut, saved artist support list, release alerts for new music on Bandcamp/Mirlo/Qobuz/Faircamp, ListenBrainz scrobbling, and social sharing.
- **iOS app** - Search, support list, and release alerts on iPhone and iPad (universal Apple app).
- **Chrome extension** - [Chrome Web Store](https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf) - Detects playback on Spotify, Apple Music, YouTube, YouTube Music, SoundCloud, and Bandcamp.
- **Firefox extension** - [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/unstream/)
- **iOS Shortcut** - Share from Spotify or Apple Music to search on Unstream

All apps are free with no paywall. If Unstream is useful to you, you can [support its development](https://unstream.stream/support).

## Project structure

```
unstream/
├── apps/
│   ├── web/                # React + Vite web app (SPA)
│   │   ├── src/            # Components, pages, services, types
│   │   └── tests/          # Unit and integration tests (Vitest)
│   ├── mac/                # Universal Apple app - macOS + iOS (SwiftUI)
│   └── extension/          # Browser extension (Chrome + Firefox)
├── api/
│   ├── functions/          # Serverless API (search, auth, analytics, embeds, admin)
│   ├── edge/               # Edge functions (OG metadata, artist page SSR, guide SSR)
│   ├── search/             # Search modules (Bandcamp, MusicBrainz, multi-source)
│   └── embed/              # Bandcamp embed resolver
├── scripts/                # Data generation (artist list, artist data, sitemap, social posts, guides)
├── data/
│   ├── artists/            # Pre-generated artist SEO data (JSON)
│   └── guides/             # Markdown guide posts with YAML frontmatter
└── public/                 # Static assets (icons, images, robots.txt, sitemap)
```

## Development

```bash
npm install
npm run dev          # Start Vite dev server
npm run build        # Full build (guides manifest + typecheck + tests + Vite + sitemap)
npm run lint         # Run ESLint
npm run test         # Run unit and integration tests
npm run test:unit    # Unit tests only
```

### Data generation

```bash
npm run generate:artists    # Fetch artist list from Wikidata
npm run generate:data       # Generate artist page data via APIs
npm run generate:social     # Generate social media posts
```

## Tech stack

- **Frontend**: React 19, Tailwind CSS v4, Vite, TypeScript
- **Backend**: Netlify Functions + Edge Functions
- **Database**: Supabase (artist profiles, analytics, merge overrides, auth)
- **Auth**: Supabase Auth (magic links + password sign-in)
- **Rate limiting**: Upstash Redis
- **Data**: MusicBrainz, Wikidata, Bandcamp API
- **Analytics**: GoatCounter (privacy-friendly, public) + custom artist analytics (Supabase)
- **Apple apps**: Swift, SwiftUI (universal macOS + iOS)
- **Browser extension**: Vanilla JS, Manifest V3 (Chrome) + V2 (Firefox)

## Links

- [Roadmap](https://unstream.featurebase.app/roadmap)
- [Public metrics](https://unstream.goatcounter.com)
- [Privacy policy](https://unstream.stream/privacy-policy)
- [Support Unstream](https://unstream.stream/support)
