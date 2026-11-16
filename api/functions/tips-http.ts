// Small shared pieces for the tips endpoints (tips-*.ts).

/**
 * A JSON answer with no CORS headers. Those depend on who is asking, so each handler builds
 * them for its request and attaches them on the way out (`withCors`): tips-connect and
 * tips-settings from account-cors.ts, tips-checkout from middleware.ts. An answer returned
 * without that step carries no Access-Control-Allow-Origin, which a browser on another origin
 * refuses, so forgetting it fails closed.
 */
export function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The methods the artist-side tips endpoints (tips-connect, tips-settings) answer between them. */
export const TIPS_ARTIST_METHODS = 'GET, POST, PUT, OPTIONS';

/**
 * The site's own origin, for Stripe's return URLs. Netlify sets URL at runtime (it is one of the
 * few build variables that reaches functions — CONTEXT and DEPLOY_PRIME_URL do not); `netlify dev`
 * sets it to the local server.
 */
export function siteUrl(): string {
  const url = process.env.URL;
  return url && /^https?:\/\//.test(url) ? url.replace(/\/$/, '') : 'https://unstream.stream';
}
