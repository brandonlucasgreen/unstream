# Unstream

**Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.**

[unstream.stream](https://unstream.stream)

Unstream searches 23+ platforms to find where your favorite artists sell music, accept patronage, or share music for free outside the streaming ecosystem. It shows artist payout percentages so you can make informed choices about where your money goes.

## How it works

Search for any artist, album, or track. Unstream checks platforms like Bandcamp, Mirlo, Faircamp, Patreon, Qobuz, and more, then shows you verified links grouped by category:

- **Music Marketplaces** - Buy music directly (Bandcamp, Mirlo, Ampwall, Qobuz, Jam.coop, Discogs)
- **Patronage** - Support artists directly (Patreon, Buy Me a Coffee, Ko-fi, Liberapay)
- **Decentralized** - Community alternatives (Bandwagon, Faircamp, PeerTube)
- **Library Services** - Free access through your library (Hoopla, Freegal)
- **Official** - Artist websites, social links, newsletter

Results are enriched with MusicBrainz data for official websites, social profiles, and release verification. On Bandcamp Fridays, results highlight which platforms pay artists 100% of the purchase price.

## Artist profiles

Artists can claim and verify their Unstream profile to customize their page with a photo, bio, featured release embed, social links, and direct support options. Verified profiles appear in the [Artist Index](https://unstream.stream/artists).

To claim a profile, search for your artist name and click "Is this you?" on your result card.

## Apps

- **Web** - [unstream.stream](https://unstream.stream) (free, no account needed)
- **macOS menu bar app** - Detects what's playing in Spotify, Apple Music, Radiccio, or Parachord and shows support options. Includes a global keyboard shortcut, tabbed settings, and social sharing.
- **Chrome extension** - [Chrome Web Store](https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf)
- **Firefox extension** - [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/unstream/)
- **iOS Shortcut** - Share from Spotify or Apple Music to search on Unstream

All apps are free with no paywall. If Unstream is useful to you, you can [donate via Liberapay](https://liberapay.com/brandonlucasgreen/donate).

## Project structure

```
unstream/
├── apps/
│   ├── web/                # React + Vite web app (SPA)
│   │   ├── src/            # Components, pages, services, types
│   │   └── tests/          # Unit and integration tests
│   ├── mac/                # macOS Swift menu bar app (SwiftUI)
│   └── extension/          # Browser extension (Chrome + Firefox)
├── netlify/
│   ├── functions/          # Serverless API (search, embed, cache, version check)
│   └── edge-functions/     # Edge middleware (OG metadata, artist page SSR)
├── api/                    # Shared API modules (search logic, embeds)
├── supabase/               # Database migrations and config
├── scripts/                # Data generation (artist list, artist data, sitemap)
├── data/                   # Pre-generated artist SEO data
├── docs/                   # Specs and planning documents
└── public/                 # Static assets (icons, images, robots.txt, sitemap)
```

## Development

```bash
npm install
npm run dev          # Start Vite dev server
npm run build        # Build for production (includes sitemap generation)
npm run lint         # Run ESLint
npm run test         # Run unit and integration tests
```

### Data generation

```bash
npm run generate:artists    # Fetch artist list from Wikidata
npm run generate:data       # Generate artist page data via APIs
```

## Tech stack

- **Frontend**: React 19, Tailwind CSS v4, Vite, TypeScript
- **Backend**: Netlify Functions + Edge Functions
- **Database**: Supabase (artist profiles and verification)
- **Data**: MusicBrainz, Wikidata, Bandcamp API
- **Analytics**: GoatCounter (privacy-friendly, public dashboard)
- **macOS app**: Swift, SwiftUI

## Links

- [Roadmap](https://unstream.featurebase.app/roadmap)
- [Public metrics](https://unstream.goatcounter.com)
- [Privacy policy](https://unstream.stream/privacy-policy)
- [Donate](https://liberapay.com/brandonlucasgreen/donate)
