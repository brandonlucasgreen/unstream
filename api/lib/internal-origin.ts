/**
 * Where our functions call our own background functions.
 *
 * **Not `URL`.** `URL` is https://unstream.stream, which sits behind Cloudflare, and whatever
 * Cloudflare decides about a request from a datacenter applies to our own Lambdas too. From
 * 2026-10-12 to 2026-10-18 its free-plan Bot Fight Mode — which has no exceptions and runs before
 * any skip rule — answered every function-to-function call with a "Just a moment…" challenge.
 * The callers treated that 403 as delivered, so release cataloguing silently did nothing for six
 * days (the GitHub runner hit the same wall first, #606). The site's own
 * `<SITE_NAME>.netlify.app` hostname is served by Netlify directly, outside Cloudflare, so no
 * setting there can do that again.
 *
 * `SITE_NAME` is one of the three variables Netlify exposes to a function at runtime (with `URL`
 * and `SITE_ID`). A preview resolves to the *production* host here, as `URL` always did, since a
 * preview can't name itself at runtime. Under `netlify dev`, `URL` is localhost and is used as is,
 * so local runs exercise the local function.
 */
export function internalFunctionOrigin(): string | null {
  const siteUrl = process.env.URL;
  const siteName = process.env.SITE_NAME;
  if (siteUrl && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl)) return siteUrl;
  if (siteName && /^[a-z0-9-]+$/.test(siteName)) return `https://${siteName}.netlify.app`;
  return siteUrl || null;
}
