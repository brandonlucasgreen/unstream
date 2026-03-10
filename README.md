# Unstream

**Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.**

[unstream.stream](https://unstream.stream)

Unstream searches 23+ platforms to find where your favorite artists sell music, accept patronage, or share music for free outside the streaming ecosystem. It shows artist payout percentages so you can make informed choices about where your money goes.

## How it works

Search for any artist, album, or track. Unstream checks platforms like Bandcamp, Mirlo, Faircamp, Patreon, Qobuz, and more, then shows you verified links grouped by category:

- **Music Marketplaces** - Buy music directly (Bandcamp, Mirlo, Ampwall, Qobuz, Jam.coop, Discogs)
- **Patronage** - Support artists directly (Patreon, Buy Me a Coffee, Ko-fi)
- **Decentralized** - Community alternatives (Bandwagon, Faircamp)
- **Library Services** - Free access through your library (Hoopla, Freegal)
- **Official** - Artist websites, social links

Results are enriched with MusicBrainz data for official websites, social profiles, and release verification.

## Apps

- **Web** - [unstream.stream](https://unstream.stream) (free, no account needed)
- **macOS menu bar app** - Detects what's playing in Spotify or Apple Music and shows support options
- **Chrome extension** - [Chrome Web Store](https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf)
- **Firefox extension** - [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/unstream/)
- **iOS Shortcut** - Share from Spotify or Apple Music to search on Unstream

The [Yearly Pass](https://bgreenlol.lemonsqueezy.com/checkout/buy/d4e127a7-2cef-4013-80b8-5d0de691f332) ($4.99/year) unlocks saved artist lists, new release alerts, and more in the desktop and browser apps.

## Project structure

```
unstream/
├── src/                    # React + Vite web app (SPA)
│   ├── components/         # UI components (SearchBar, ResultCard, SourceBadge)
│   ├── pages/              # Route pages (ArtistPage, PrivacyPolicy, Roadmap)
│   ├── services/           # Platform definitions, analytics
│   └── types/              # TypeScript type definitions
├── netlify/
│   ├── functions/          # Serverless API (search, embed, cache, version check)
│   └── edge-functions/     # Edge middleware (OG metadata, artist page SSR)
├── api/                    # Shared API modules (search logic, embeds)
├── server/                 # Vite dev server API handler
├── chrome-extension/       # Browser extension (Chrome + Firefox)
├── UnstreamMenubar/        # macOS Swift menu bar app
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
```

### Data generation

```bash
npm run generate:artists    # Fetch artist list from Wikidata
npm run generate:data       # Generate artist page data via APIs
```

## Tech stack

- **Frontend**: React 19, Tailwind CSS v4, Vite, TypeScript
- **Backend**: Netlify Functions + Edge Functions
- **Data**: MusicBrainz, Wikidata, Bandcamp API
- **Analytics**: GoatCounter (privacy-friendly, public dashboard)
- **Payments**: Lemon Squeezy
- **macOS app**: Swift, SwiftUI

## Links

- [Roadmap](https://unstream.featurebase.app/roadmap)
- [Public metrics](https://unstream.goatcounter.com)
- [Privacy policy](https://unstream.stream/privacy-policy)
- [Donate](https://liberapay.com/brandonlucasgreen/donate)
