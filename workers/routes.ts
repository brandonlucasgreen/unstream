// The Worker's routing table: what answers each URL.
//
// This replaces netlify.toml's `[[redirects]]` and `[[edge_functions]]` blocks, and keeps their
// two load-bearing properties:
//
// 1. **Order is the rule.** Netlify matched redirects first-match-wins, and so does `matchRoute`.
//    The release feeds must stay above the SPA catch-all or a calendar client gets HTML; the
//    release page must stay above `/a/*` or the artist renderer answers first and costs a
//    database query per view. Both of those are load-bearing and both are preserved by position.
// 2. **Edge renderers run before rewrites.** On Netlify the edge layer saw a request first, which
//    is why `/a/:artist/releases.xml` needed an `excludedPattern` on two separate edge entries.
//    Here there is one list, so the feed routes simply sit above the page renderers and the
//    exclusions disappear — the ordering says the same thing in one place instead of three.
//
// `workers/__tests__/routes.test.ts` asserts every `[[redirects]]` and `[[edge_functions]]` entry
// in netlify.toml still has a route here. That test exists for the cutover window, while Netlify
// is kept idle for rollback, and goes when netlify.toml does.

export type Route =
  /** Hand off to a function handler in api/functions/. */
  | { pattern: string; kind: 'function'; name: string }
  /** Hand off to a server-rendered page in api/edge/. */
  | { pattern: string; kind: 'edge'; name: string }
  /** A permanent redirect. */
  | { pattern: string; kind: 'redirect'; to: string; status: 301 }
  /**
   * A build asset that isn't there. Must 404 rather than fall through to the SPA: a superseded
   * chunk served as `200 text/html` becomes a MIME error whose wording differs per browser
   * engine, and `lazyWithRetry`'s auto-reload was broken twice chasing those sentences
   * (PR #390, then #417 for WebKit's). A real 404 is a fetch failure, which every engine
   * already reports in wording `isStaleBuildAssetError` matches.
   */
  | { pattern: string; kind: 'missing-asset' }
  /** Serve the SPA shell. */
  | { pattern: string; kind: 'spa' };

/**
 * Server-rendered pages, above the function rewrites and the SPA catch-all.
 *
 * `release-page` is pure SSR for everyone. The rest render for crawlers and call `next()` for
 * real browsers, which serves the SPA — one route, one renderer, decided per request before any
 * query (see "One route, one renderer" in CLAUDE.md).
 */
const EDGE_ROUTES: Route[] = [
  { pattern: '/', kind: 'edge', name: 'og-metadata' },
  // Exactly two segments under /a/, so single-segment artist URLs never reach it. The feed
  // routes below `FUNCTION_ROUTES` used to need an excludedPattern here; now they just sit
  // above it in the combined list.
  { pattern: '/a/:artist/:release', kind: 'edge', name: 'release-page' },
  { pattern: '/artist/*', kind: 'edge', name: 'artist-page-static' },
  { pattern: '/a/*', kind: 'edge', name: 'artist-page-static' },
  { pattern: '/search', kind: 'edge', name: 'noscript-search' },
  { pattern: '/u/*', kind: 'edge', name: 'u-handle' },
  { pattern: '/tip/*', kind: 'edge', name: 'tip-page-meta' },
  // Link previews for the hand-written static pages. Their titles are set client-side, so
  // without these an unfurl of /press shows the homepage's card.
  { pattern: '/press', kind: 'edge', name: 'static-page-meta' },
  { pattern: '/contact', kind: 'edge', name: 'static-page-meta' },
  { pattern: '/platforms', kind: 'edge', name: 'static-page-meta' },
];

/** Ported one-for-one from netlify.toml's `[[redirects]]`, in the same order. */
const FUNCTION_ROUTES: Route[] = [
  { pattern: '/api/artist-directory', kind: 'function', name: 'artist-directory' },
  { pattern: '/api/search/sources', kind: 'function', name: 'search-sources' },
  { pattern: '/api/search/stored', kind: 'function', name: 'search-stored' },
  { pattern: '/api/suggest', kind: 'function', name: 'search-suggest' },
  { pattern: '/api/search/musicbrainz', kind: 'function', name: 'search-musicbrainz' },
  { pattern: '/api/embed/bandcamp', kind: 'function', name: 'embed-bandcamp' },
  { pattern: '/api/resolve/url', kind: 'function', name: 'resolve-url' },
  { pattern: '/api/artist', kind: 'function', name: 'artist-lookup' },
  { pattern: '/api/claim', kind: 'function', name: 'claim-artist' },
  { pattern: '/api/artist-auth', kind: 'function', name: 'artist-auth' },
  { pattern: '/api/saved-artists/sync', kind: 'function', name: 'saved-artists-sync' },
  { pattern: '/api/saved-artists', kind: 'function', name: 'saved-artists' },
  { pattern: '/api/tips/connect', kind: 'function', name: 'tips-connect' },
  { pattern: '/api/tips/settings', kind: 'function', name: 'tips-settings' },
  { pattern: '/api/tips/checkout', kind: 'function', name: 'tips-checkout' },
  { pattern: '/api/tips/webhook', kind: 'function', name: 'tips-webhook' },
  { pattern: '/api/me/tips', kind: 'function', name: 'me-tips' },
  { pattern: '/api/admin/tips', kind: 'function', name: 'admin-tips' },
  { pattern: '/api/me/settings', kind: 'function', name: 'me-settings' },
  { pattern: '/api/me/username', kind: 'function', name: 'me-username' },
  { pattern: '/api/me/location', kind: 'function', name: 'me-location' },
  { pattern: '/api/me/password', kind: 'function', name: 'me-password' },
  { pattern: '/api/me/email', kind: 'function', name: 'me-email' },
  { pattern: '/api/me/email/confirm', kind: 'function', name: 'me-email-confirm' },
  { pattern: '/api/me/bandcamp', kind: 'function', name: 'me-bandcamp' },
  { pattern: '/api/me/collection', kind: 'function', name: 'me-collection' },
  { pattern: '/api/collection/art/*', kind: 'function', name: 'collection-art' },
  { pattern: '/api/social-card/*', kind: 'function', name: 'social-card' },
  { pattern: '/api/newsletter/subscribe', kind: 'function', name: 'newsletter-subscribe' },
  { pattern: '/api/me/saved-artists-sharing', kind: 'function', name: 'user-sharing' },
  { pattern: '/api/me/notification-preferences', kind: 'function', name: 'me-notifications' },
  { pattern: '/api/me/listening', kind: 'function', name: 'me-listening' },
  { pattern: '/api/public/saved-artists/*', kind: 'function', name: 'public-saved-artists' },
  { pattern: '/api/artist-page', kind: 'function', name: 'artist-page' },
  { pattern: '/api/artist-profile', kind: 'function', name: 'artist-profile' },
  { pattern: '/api/artist-releases', kind: 'function', name: 'artist-releases' },
  { pattern: '/api/desktop/version', kind: 'function', name: 'desktop-version' },
  { pattern: '/appcast.xml', kind: 'function', name: 'desktop-appcast' },
  { pattern: '/api/analytics/event', kind: 'function', name: 'analytics-event' },
  { pattern: '/api/analytics/stats', kind: 'function', name: 'analytics-stats' },
  { pattern: '/api/analytics/app-event', kind: 'function', name: 'analytics-app-event' },
  { pattern: '/api/analytics/dashboard', kind: 'function', name: 'analytics-dashboard' },
  { pattern: '/api/admin/merge-override', kind: 'function', name: 'admin-merge-override' },
  { pattern: '/api/admin/verify', kind: 'function', name: 'admin-verify' },
  { pattern: '/api/admin/link-suppression', kind: 'function', name: 'admin-link-suppression' },
  { pattern: '/api/admin/catalog-artist', kind: 'function', name: 'admin-catalog-artist' },
  { pattern: '/api/admin/release-review', kind: 'function', name: 'admin-release-review' },
  { pattern: '/api/admin/artist-duplicates', kind: 'function', name: 'admin-artist-duplicates' },
  { pattern: '/api/admin/flags', kind: 'function', name: 'admin-flags' },
  { pattern: '/api/v1/search', kind: 'function', name: 'search-sources-v1' },
  { pattern: '/api/v1/artist/*', kind: 'function', name: 'artist-lookup-v1' },
  { pattern: '/api/v1/resolve', kind: 'function', name: 'resolve-url-v1' },
  { pattern: '/api/v1/platforms', kind: 'function', name: 'platforms-list' },
  { pattern: '/api/v1/status', kind: 'function', name: 'api-status' },
  { pattern: '/api/v1/keys', kind: 'function', name: 'api-key-generate' },
  { pattern: '/feed/f/*', kind: 'function', name: 'feed-releases' },
  { pattern: '/u/:handle/releases.ics', kind: 'function', name: 'feed-releases' },
  { pattern: '/u/:handle/releases.xml', kind: 'function', name: 'feed-releases' },
  { pattern: '/a/:artist/releases.xml', kind: 'function', name: 'feed-releases' },
  { pattern: '/a/:artist/releases.ics', kind: 'function', name: 'feed-releases' },
  { pattern: '/digest/feed.xml', kind: 'function', name: 'digest-feed' },
  { pattern: '/api/me/feed-token', kind: 'function', name: 'me-feed-token' },
  { pattern: '/api/me/recent-releases', kind: 'function', name: 'me-recent-releases' },
  { pattern: '/api/release/:artist/:release', kind: 'function', name: 'release-detail' },
  { pattern: '/plus', kind: 'redirect', to: '/support', status: 301 },
  { pattern: '/guides/why-i-built-unstream', kind: 'redirect', to: 'https://dispatch.kidlightbulbs.com/archive/introducing-unstream-a-simple-way-to-search/', status: 301 },
  { pattern: '/guides/every-platform-unstream-supports-compared', kind: 'redirect', to: '/platforms', status: 301 },
  { pattern: '/guides/bandcamp-and-beyond-alternative-music-platforms-worth-knowing', kind: 'redirect', to: '/platforms', status: 301 },
  { pattern: '/guides/*', kind: 'redirect', to: '/faq', status: 301 },
  { pattern: '/guides', kind: 'redirect', to: '/platforms', status: 301 },
  { pattern: '/assets/*', kind: 'missing-asset' },
  { pattern: '/*', kind: 'spa' },];

/**
 * The feed routes, and anything else that must be matched before a page renderer swallows it.
 *
 * On Netlify these lived among the redirects but needed `excludedPattern` entries on the `/a/*`
 * and `/u/*` edge functions, because the edge layer ran first. Here, position is the whole
 * mechanism: they are spliced in above EDGE_ROUTES.
 */
const FEED_PATTERNS = new Set([
  '/feed/f/*',
  '/u/:handle/releases.ics',
  '/u/:handle/releases.xml',
  '/a/:artist/releases.xml',
  '/a/:artist/releases.ics',
  '/digest/feed.xml',
]);

/**
 * The full table, in match order: feeds, then server-rendered pages, then the function
 * rewrites, then the redirects and the SPA catch-all that end the list.
 */
export const ROUTES: Route[] = [
  ...FUNCTION_ROUTES.filter((route) => FEED_PATTERNS.has(route.pattern)),
  ...EDGE_ROUTES,
  ...FUNCTION_ROUTES.filter((route) => !FEED_PATTERNS.has(route.pattern)),
];

export interface RouteMatch {
  route: Route;
  /** Values captured by `:name` segments. Informational: handlers read `event.path` instead. */
  params: Record<string, string>;
}

/**
 * Match a pathname against one pattern.
 *
 * Supports exactly what netlify.toml used: a literal path, a trailing `*` splat, and `:name`
 * segments. Nothing more — a richer matcher would be a new way for two routes to disagree.
 */
export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return {};
    return null;
  }
  if (pattern === '/*') return {};

  const patternParts = pattern.split('/');
  const pathParts = pathname.replace(/\/$/, '').split('/');
  // A bare '/' survives the trailing-slash strip as ['', ''] vs [''].
  if (pathname === '/' && pattern === '/') return {};
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    if (patternPart.startsWith(':')) {
      if (!pathParts[i]) return null;
      params[patternPart.slice(1)] = decodeURIComponent(pathParts[i]);
      continue;
    }
    if (patternPart !== pathParts[i]) return null;
  }
  return params;
}

/** First match wins, exactly as Netlify's redirect engine did. */
export function matchRoute(pathname: string): RouteMatch | null {
  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}
