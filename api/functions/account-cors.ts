// CORS for the endpoints a signed-in person calls with a Bearer token and no API key: the
// `me-*` endpoints, saved artists, and the artist's own (claim, profile, analytics, tips).
//
// These handlers cannot use middleware.ts's buildCorsHeaders(): that one collapses every
// non-matching origin down to unstream.stream, so `netlify dev` (localhost:8888) and Vite
// (localhost:5173) break under Bearer auth. They must not keep the hand-rolled
// `Access-Control-Allow-Origin: '*'` either — the caller is a signed-in user, so a wildcard
// lets any origin probe these endpoints with a token it has somehow obtained (fix list
// item 1 on UNS-212). This is the narrow, allowlisted version the account endpoints need.
//
// Who is on the other end, and why a narrow answer breaks none of them (checked 2026-11-16):
//   - The web app calls every one of these by a relative `/api/...` path, so in production,
//     under `npm run dev` and on a deploy preview the request is same-origin and the browser
//     never consults these headers. SITE_ORIGIN is therefore not needed for previews.
//   - The Mac and iOS apps are not browsers and ignore CORS.
//   - The browser extension makes no API call from a content script (so no streaming site's
//     origin ever arrives here). Its popup calls saved-artists and saved-artists/sync from the
//     extension's own origin — see `allowExtensionOrigins` below.
//
// collection-art.ts and public-saved-artists.ts keep their wildcard on purpose; each says why.

/** The production site plus the local dev origins the SPA is served from. */
const DEFAULT_ACCOUNT_ORIGINS = [
  'https://unstream.stream',
  'http://localhost:8888',
  'http://localhost:5173',
  'http://127.0.0.1:8888',
  'http://127.0.0.1:5173',
];

/**
 * Comma-separated extra origins from SITE_ORIGIN (e.g. a preview deploy or a test host),
 * always on top of the built-in site + local-dev origins.
 */
function accountOriginAllowlist(): string[] {
  const configured = (process.env.SITE_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...DEFAULT_ACCOUNT_ORIGINS, ...configured];
}

/**
 * A browser extension's own pages (`chrome-extension://<id>`, `moz-extension://<uuid>`).
 *
 * The extension's popup is normally exempt from CORS, because the extension holds the host
 * permission for unstream.stream. That permission can be missing, though: Firefox treats an
 * MV3 extension's host permissions as optional (not granted at install before Firefox 127,
 * and revocable since), and Chrome lets a person switch an extension's site access to "on
 * click". The popup's request is then an ordinary cross-origin one, and only the old wildcard
 * let it through. Its failures are silent by design (the local save is kept), so refusing it
 * would stop saves syncing with nothing to show for it.
 *
 * Matched by scheme, not by id: Firefox mints a different id for every install. A web page
 * can't present one of these origins, so this opens nothing to the sites the allowlist is for.
 */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;

/**
 * Build CORS headers for a Bearer-authenticated account endpoint.
 *
 * Echoes the request origin only when it is allowlisted; anything else is answered with the
 * primary site origin, which the browser then refuses to hand to the caller. Never returns
 * '*'. There is no `Access-Control-Allow-Credentials`: these endpoints authorize with a
 * Bearer token, not a cookie, so the browser must not be invited to send one.
 *
 * `allowExtensionOrigins` also echoes a browser extension's own origin. Pass it only on an
 * endpoint the extension's popup calls: today saved-artists and saved-artists-sync.
 */
export function buildAccountCorsHeaders(
  origin: string | undefined,
  methods: string,
  options: { allowExtensionOrigins?: boolean } = {},
): Record<string, string> {
  const allowlist = accountOriginAllowlist();
  const allowed = !!origin && (
    allowlist.includes(origin)
    || (options.allowExtensionOrigins === true && EXTENSION_ORIGIN.test(origin))
  );
  const allowOrigin = allowed ? origin : allowlist[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': methods,
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}
