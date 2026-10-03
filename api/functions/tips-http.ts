// Small shared pieces for the tips endpoints (tips-*.ts).

export const TIPS_CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};

export function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: TIPS_CORS_HEADERS, body: JSON.stringify(body) };
}

/**
 * The site's own origin, for Stripe's return URLs. Netlify sets URL at runtime (it is one of the
 * few build variables that reaches functions — CONTEXT and DEPLOY_PRIME_URL do not); `netlify dev`
 * sets it to the local server.
 */
export function siteUrl(): string {
  const url = process.env.URL;
  return url && /^https?:\/\//.test(url) ? url.replace(/\/$/, '') : 'https://unstream.stream';
}
