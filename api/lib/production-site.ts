/**
 * Whether this deployment is the real site.
 *
 * Every runtime that is *not* production still talks to production Supabase — `npm run dev`,
 * deploy previews, the staging Worker — so a few things must refuse to run anywhere else: the
 * scheduled jobs, and a live Stripe key. They ask here so that they agree.
 *
 * `URL` is the signal on both platforms: Netlify injects it as the site's main address (checked
 * 2026-10-21: `https://unstream.stream`), and wrangler.jsonc sets it per environment, with the
 * staging environment overriding it to `https://next.unstream.stream`. `npm run dev` sees
 * localhost.
 *
 * **It cannot tell a Netlify deploy preview from production.** A preview's `URL` is the
 * production address too (see api/lib/internal-origin.ts), and the variables that would say
 * otherwise — `CONTEXT`, `DEPLOY_PRIME_URL` — never reach a function at runtime. So on a preview
 * this answers true, and what keeps a preview safe is its configuration: the Deploy Preview
 * context holds a test Stripe key and no scheduled-job flag. Staging and `npm run dev` are the
 * runtimes this check actually covers.
 *
 * In api/lib/ rather than api/shared/ on purpose: shared/ is also imported by the Deno edge pages,
 * where `process` does not exist and reading it would throw.
 */
const PRODUCTION_SITE_URL = 'https://unstream.stream';

export function isProductionSite(url: string | undefined = process.env.URL): boolean {
  return url?.replace(/\/$/, '') === PRODUCTION_SITE_URL;
}
