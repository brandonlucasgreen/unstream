// The Content-Security-Policy the Worker puts on the responses it generates itself.
//
// netlify.toml's `[[headers]]` blocks covered three things. Two of them — the caching rules for
// `/sw.js` and `/build-id.json` — are properties of static files, which Workers serves without
// running the Worker at all, so they live in `apps/web/public/_headers` instead. The CSP is
// stated in both places, because a server-rendered page never passes through `_headers` and a
// static file never passes through here; `workers/__tests__/response-headers.test.ts` is what
// keeps the two copies identical.

/**
 * The site-wide Content-Security-Policy.
 *
 * connect-src: Sentry's ingest host is region-scoped — ours is `o….ingest.us.sentry.io`.
 * `*.ingest.sentry.io` does NOT cover it: CSP host wildcards are a suffix match, and
 * `.ingest.sentry.io` is not a suffix of `.ingest.us.sentry.io`. That one missing `us.` silently
 * dropped every browser error event between setup and 2026-08-01. If the Sentry org ever moves
 * region, this host moves with it.
 *
 * Fonts: coollabs uses TWO hosts, the same split Google Fonts did. The stylesheet comes from
 * api.fonts.coollabs.io (style-src); the .woff2 files it references come from their BunnyCDN at
 * cdn.fonts.coollabs.io (font-src). Their README's migration snippet shows one preconnect and
 * implies one origin — that is wrong, and following it puts the wrong host in font-src. Getting
 * it wrong fails silently: the faces are blocked and every page falls back to system-ui without
 * erroring.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' gc.zgo.at letterbird.co; " +
  "style-src 'self' 'unsafe-inline' api.fonts.coollabs.io; font-src cdn.fonts.coollabs.io; " +
  "connect-src 'self' https://*.supabase.co https://unstream.goatcounter.com https://letterbird.co " +
  "https://*.ingest.us.sentry.io; img-src 'self' https: data:; frame-src https:; object-src 'none'; " +
  "base-uri 'self'";

/**
 * Apply the site-wide headers to a response the Worker generated.
 *
 * Only the CSP, and only here: static files are served without running the Worker, so their
 * headers — including `/sw.js` and `/build-id.json`, whose caching rules are load-bearing — come
 * from `apps/web/public/_headers` and never pass through this function. Repeating them here
 * would be dead code that looks like a safety net.
 *
 * Returns a new Response rather than mutating: a Response from the static-asset binding has
 * immutable headers.
 */
export function withSiteHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
