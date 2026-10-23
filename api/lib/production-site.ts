/**
 * Whether this deployment is the real site.
 *
 * Every runtime that is *not* production still talks to production Supabase — `npm run dev` and
 * deploy previews — so a few things must refuse to run anywhere else: a live Stripe key, and the
 * Sentry environment tag. They ask here so that they agree.
 *
 * `URL` is the signal: Netlify injects it as the site's main address (checked 2026-10-21:
 * `https://unstream.stream`), and `npm run dev` sees localhost.
 *
 * **It cannot tell a Netlify deploy preview from production.** A preview's `URL` is the
 * production address too (see api/lib/internal-origin.ts), and the variables that would say
 * otherwise — `CONTEXT`, `DEPLOY_PRIME_URL` — never reach a function at runtime. So on a preview
 * this answers true, and what keeps a preview safe is its configuration: the Deploy Preview
 * context holds a test Stripe key. `npm run dev` is the runtime this check actually covers.
 *
 * In api/lib/ rather than api/shared/ on purpose: shared/ is also imported by the Deno edge pages,
 * where `process` does not exist and reading it would throw.
 */
const PRODUCTION_SITE_URL = 'https://unstream.stream';

export function isProductionSite(url: string | undefined = process.env.URL): boolean {
  return url?.replace(/\/$/, '') === PRODUCTION_SITE_URL;
}
