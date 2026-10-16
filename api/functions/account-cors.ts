// CORS for the authenticated `me-*` endpoints (Bearer token, no API key).
//
// These handlers cannot use middleware.ts's buildCorsHeaders(): that one collapses every
// non-matching origin down to unstream.stream, so `netlify dev` (localhost:8888) and Vite
// (localhost:5173) break under Bearer auth. They must not keep the hand-rolled
// `Access-Control-Allow-Origin: '*'` either — the caller is a signed-in user, so a wildcard
// lets any origin probe these endpoints with a token it has somehow obtained (fix list
// item 1 on UNS-212). This is the narrow, allowlisted version the account endpoints need.

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
 * Build CORS headers for an authenticated `me-*` endpoint.
 *
 * Echoes the request origin only when it is allowlisted; anything else is answered with the
 * primary site origin, which the browser then refuses to hand to the caller. Never returns
 * '*'. There is no `Access-Control-Allow-Credentials`: these endpoints authorize with a
 * Bearer token, not a cookie, so the browser must not be invited to send one.
 */
export function buildAccountCorsHeaders(
  origin: string | undefined,
  methods: string,
): Record<string, string> {
  const allowlist = accountOriginAllowlist();
  const allowOrigin = origin && allowlist.includes(origin) ? origin : allowlist[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': methods,
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}
