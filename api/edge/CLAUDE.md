# api/edge/ — edge functions (SSR/SEO)

Read this with the root `CLAUDE.md` and `api/CLAUDE.md`. The root file's "One route, one renderer" principle is the rule everything here follows.

Every `.ts` file in this folder is deployed as an edge function and must default-export a handler (`edge-directory-shape.test.ts`); shared code for the renderers goes in `api/shared/`. This file is safe here because Netlify's edge bundler only picks up `.js` and `.ts` files.

## Edge functions (SSR/SEO)

Routed in `netlify.toml`: `/` → `og-metadata`; `/a/{artist}/{release}` → `release-page` (a regex entry, which must stay above `/a/*`); `/artist/*` and `/a/*` → `artist-page-static`; `/search` → `noscript-search`; `/u/*` → `u-handle`; `/press`, `/contact`, `/platforms` → `static-page-meta` (link previews only). `/a/*/releases.{ics,xml}` and `/u/*/releases.{ics,xml}` are excluded from the edge routes and go to the `feed-releases` function.

**Who gets which renderer.** `release-page` is pure SSR for everyone. `artist-page-static` and `u-handle` render only for crawlers (`api/shared/crawler-detection.ts`) and hand real browsers to the SPA before any database query, so a direct load and an in-app click produce the same UI.

**An artist URL that misses resolves in three steps, never a guess of our own.** Live `artists.slug`, then `artist_slug_aliases`, then a slug guessed from the artist's name (`/a/impulse-nine` → `impulsenine`) if exactly one artist's name slugifies to it (`api/shared/guessed-slug.ts`, used by `resolveArtistSlugAlias`, `artist-page-static` and `release-page`). A definite miss answers crawlers a real 404 with `noindex`; the SPA shell's 200 was a soft 404 in Search Console. Clients link to `/a/<claimedSlug>` or to search, **never `/a/<slugified name>`**: an artist's slug isn't always their name.

**The release page draws the app's header and footer from `api/shared/site-chrome.ts`** (both the signed-out nav and the Account menu, picked in the browser by `SIGNED_IN_SCRIPT` from Supabase's localStorage session, since the page is cached per URL; the search row, menu and dropdown are `<details>`), since it can't render the React ones; `site-chrome-copies.test.ts` fails when its links stop matching `Header.tsx` or `Footer.tsx`. Platform marks for every edge page come from `api/shared/platform-logos.ts` (`PLATFORM_MARKS`), which the SPA's `PlatformIcon` reads too — add a mark there, not in `PlatformIcon.tsx`.

**Edge responses are cached only on opt-in.** Netlify ignores an edge function's `Netlify-CDN-Cache-Control` unless the function declares `cache = "manual"`; only `release-page` does (2026-10-18). Before that, every release page view queried Supabase despite its hour-long TTL. Don't opt in a function that answers crawlers and browsers differently at one URL: the cache key is the URL, so people would be served the crawler render.

`/artists` is SPA-only after UNS-98; `artist-directory-page` was removed. Edge functions run on Deno and import from URLs (`edge.netlify.com`, `esm.sh`) — they can't import from `api/functions/`, so shared constants get duplicated or pulled from `api/shared/`.

## Two rules kept from the Cloudflare Workers port

The port itself was removed (root `CLAUDE.md`, "Cloudflare Workers: tried and removed"). These hold on Netlify too:

- **`api/edge/*.ts` read configuration with `edgeEnv()`** (`api/shared/edge-context.ts`), never a
  bare `process.env`: `process` doesn't exist on Netlify's Deno edge, and the first request would
  throw. The renderers take the small `Context` declared there rather than Netlify's type.
- **`CDN-Cache-Control`, not `Netlify-CDN-Cache-Control`.** Netlify honours the standard name.

## Typechecking

`tsc` cannot see these files. Run `npm run typecheck:edge` (`deno check`) after touching anything here or anything in `api/shared/` an edge function imports; `api/CLAUDE.md`, "Typecheck coverage", says why it is not part of `npm run verify`.

## Seeing the release page locally

`npm run dev` renders `/a/{artist}/{release}` through the real `api/edge/release-page.ts` and matches production; `dev:fast` runs no edge functions at all. The gap is data — production Supabase only holds a release once cataloging has run for that artist — so `npm run preview:release -- <bandcamp-slug-or-url>` (the *artist's* Bandcamp, then `http://localhost:8788`, which lists the discography) renders any release through the **real** edge function, fetching its Bandcamp page on demand. Only the database reads (artist, slug alias, release) are stubbed, so nothing can be written.

In a worktree, `npm run dev` serves the main checkout's edge functions and there is no flag to move them: `api/CLAUDE.md`, "Running `npm run dev` from a worktree".
