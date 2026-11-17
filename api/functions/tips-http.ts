// Small shared pieces for the tips endpoints (tips-*.ts).

/**
 * A JSON answer in the shape the endpoint wrapper (http/endpoint.ts) takes from a handler. The
 * wrapper turns the body into JSON and adds the CORS headers for the request on every answer, so
 * the tips endpoints build no header of their own.
 */
export function respond(status: number, body: unknown) {
  return { status, body };
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
