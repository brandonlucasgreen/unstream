// Caching a server-rendered page on Cloudflare's own edge.
//
// **A Worker's response is not cached by anything unless the Worker says so.** Cloudflare's CDN
// caches what comes back from an origin; a `Response` built inside a Worker never passes through
// that, so `CDN-Cache-Control` on it is inert on its own. The Cache API is the mechanism, and it
// is explicitly opt-in: `caches.default.put()` to store, `.match()` to read back.
//
// That is the same shape the Netlify version had, and the same trap: there, an edge function's
// cache headers did nothing until `cache = "manual"` appeared in netlify.toml, and until it did
// (2026-10-18) every release page view queried Supabase while looking perfectly healthy. The
// equivalent opt-in here is `cache: true` on a route in workers/routes.ts, and it is on exactly
// one route for the same reason it was on exactly one function there.
//
// **Two policies, one response.** A page tells the CDN how long it may keep a copy
// (`CDN-Cache-Control`) and the browser something much shorter (`Cache-Control`) — for the
// release page, "revalidate every time", because its prices are user-visible. The Cache API reads
// only `Cache-Control`, so the stored copy carries the CDN policy there and keeps the browser's
// own value aside under `BROWSER_POLICY_HEADER`, which is put back on the way out. Without that,
// a cache hit would hand the visitor the CDN's hour-long policy and their browser would hold a
// release page for an hour.

/** Where the browser's own Cache-Control is parked while the stored copy carries the CDN's. */
const BROWSER_POLICY_HEADER = 'x-browser-cache-control';

function withHeaders(response: Response, mutate: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  mutate(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The copy that goes into the cache: CDN policy as Cache-Control, browser's parked beside it. */
function toStoredCopy(response: Response, cdnPolicy: string): Response {
  return withHeaders(response, (headers) => {
    const browserPolicy = headers.get('Cache-Control');
    if (browserPolicy) headers.set(BROWSER_POLICY_HEADER, browserPolicy);
    headers.set('Cache-Control', cdnPolicy);
    // `CDN-Cache-Control` is left on deliberately. The Cache API reads only `Cache-Control`, so
    // it costs nothing, and keeping it means a hit and a miss are byte-identical to the client —
    // it is a header both Netlify and Cloudflare pass downstream rather than consume.
  });
}

/** The copy that goes to the visitor: their own policy back where it belongs. */
function fromStoredCopy(response: Response): Response {
  const browserPolicy = response.headers.get(BROWSER_POLICY_HEADER);
  return withHeaders(response, (headers) => {
    if (browserPolicy) headers.set('Cache-Control', browserPolicy);
    headers.delete(BROWSER_POLICY_HEADER);
  });
}

/**
 * Serve `render()` through Cloudflare's cache when the page asks to be cached.
 *
 * A page opts in by sending `CDN-Cache-Control`; anything else — a redirect, an error, a
 * fall-through, a `no-store` — is passed straight through and never stored. That matters more
 * than it looks: a database timeout on the release page renders as a pass-through to the SPA
 * shell, and storing *that* would pin a blank page to a release URL for an hour. Never cache
 * uncertainty.
 */
export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  render: () => Promise<Response>,
): Promise<Response> {
  // `cache.put` rejects anything but GET, and a HEAD has no body worth storing.
  if (request.method !== 'GET') return render();

  const cache = caches.default;

  const hit = await cache.match(request);
  if (hit) return fromStoredCopy(hit);

  const response = await render();

  const cdnPolicy = response.headers.get('CDN-Cache-Control');
  if (response.status !== 200 || !cdnPolicy || cdnPolicy.includes('no-store')) return response;
  // A Set-Cookie would make this a per-visitor response; the Cache API refuses it outright, and
  // a page that grew one should stop being cached rather than start throwing.
  if (response.headers.has('Set-Cookie')) return response;

  // Stored after the response has gone, so a visitor never waits for the write.
  ctx.waitUntil(cache.put(request, toStoredCopy(response.clone(), cdnPolicy)));

  return response;
}
