// Ask for artists to be catalogued, without waiting for it to happen.
//
// Both callers are on a user's critical path — saving an artist and running a search — so the
// only work done here is one HTTP call to a Netlify Background Function, which returns 202 as
// soon as it's accepted. All the gating (cooldown, hourly cap, claim) happens inside that
// function rather than here, so the hot path never pays a database round trip per artist.
//
// This is the mistake the abandoned first attempt at Releases made: it did the release writes
// inline in persistSearchResults, which is awaited during search, adding an estimated
// 0.6–1.6s to every query after a long effort to get search down to ~1.8–3.0s.

import type { CatalogTrigger } from './db';

/** Matches MAX_ARTISTS_PER_RUN in catalog-artist-background.ts. */
const MAX_ARTISTS_PER_REQUEST = 25;

/**
 * Is this deploy allowed to catalog?
 *
 * **Not `CONTEXT`.** That gate was unimplementable: Netlify exposes only `URL`, `SITE_NAME` and
 * `SITE_ID` to a serverless function at runtime — `CONTEXT` and `DEPLOY_PRIME_URL` are
 * build-time variables. So `process.env.CONTEXT` is `undefined` in every deployed function, and
 * the three `CONTEXT !== 'production'` checks this replaces refused *everything, in production,
 * always*. Cataloging had never run once. It surfaced only when the admin button reported the
 * refusal out loud — before that it was a `console.log` nobody reads.
 *
 * A custom variable is the documented way to get a per-context value into a function: set
 * `RELEASE_CATALOG_ENABLED=true` scoped to Functions, for the **Production context only**.
 * Deploy previews and branch deploys then get no value and stay off, which is the whole point —
 * previews run against the *production* Supabase, so an ungated one would write real releases
 * and spend the real hourly crawl budget on traffic that isn't real.
 *
 * Unset means off. A crawl budget that fails open is worse than one that fails closed.
 */
export function isCatalogEnabled(): boolean {
  return process.env.RELEASE_CATALOG_ENABLED === 'true';
}

/**
 * Request release cataloging for one or more artists.
 *
 * Awaited deliberately, despite being "fire and forget" in spirit: un-awaited work is killed
 * when the Lambda freezes after the response, so a floating promise here would mean the
 * invocation sometimes never leaves. What's awaited is only the 202 handshake, not the
 * cataloging.
 *
 * Never throws and never blocks meaningfully — cataloging is opportunistic, and a fan saving
 * an artist must not see an error because a crawl couldn't be scheduled.
 */
export async function requestArtistCatalog(
  artistIds: string[],
  trigger: CatalogTrigger
): Promise<void> {
  const ids = [...new Set(artistIds.filter(Boolean))].slice(0, MAX_ARTISTS_PER_REQUEST);
  if (ids.length === 0) return;

  // Deploy previews and branch deploys share the *production* Supabase, so an ungated one would
  // write real releases and spend the real hourly crawl budget on traffic that isn't real.
  //
  // Do NOT set RELEASE_CATALOG_ENABLED locally to test — .env points at production, so that
  // would have a laptop writing real rows. Use `npm run ingest:try <artist>` instead, which runs
  // the real fetch, parse and mapping and prints what would be written.
  if (!isCatalogEnabled()) {
    console.log('[catalog] not requested — RELEASE_CATALOG_ENABLED is not set on this deploy');
    return;
  }

  const secret = process.env.INTERNAL_FUNCTION_SECRET;

  // `URL` and not `DEPLOY_PRIME_URL`: only URL, SITE_NAME and SITE_ID reach a function at
  // runtime, so DEPLOY_PRIME_URL is always undefined here. That means a preview would invoke the
  // *production* background function — which is exactly why the gate above has to hold.
  const siteUrl = process.env.URL;

  if (!secret || !siteUrl) {
    // Not an error worth surfacing: without configuration the feature is simply off.
    console.log('[catalog] not requested — INTERNAL_FUNCTION_SECRET or site URL not configured');
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(`${siteUrl}/.netlify/functions/catalog-artist-background`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ artistIds: ids, trigger }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // A failed handshake means these artists don't get catalogued this time. The next search
    // or save asks again, so there's nothing to retry and nothing a user should see.
    console.warn('[catalog] request failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The result of a *deliberate* catalog request — someone pressed a button and is waiting for an
 * answer, so unlike `requestArtistCatalog` above every refusal is reported rather than logged.
 */
export type TriggerCatalogResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Queue a crawl for one artist, on purpose, and say why not if it can't happen.
 *
 * **Every refusal the background function could make is checked here instead**, because its
 * answer never comes back: Netlify's dispatcher returns 202 the instant it accepts a background
 * invocation and discards whatever the handler returns, so a 401 from a bad secret and a 403
 * from a disabled deploy both reach the caller as 202. Anything not checked up front is
 * indistinguishable from a slow crawl — which is exactly how cataloging stayed silently broken
 * for days before the admin button reported a refusal out loud.
 *
 * Callers are responsible for clearing the cooldown first (`clearCatalogCooldown` in db.ts) —
 * kept separate so this module needs no database access, and therefore no import from db.ts,
 * which imports from here.
 */
export async function triggerCatalogNow(artistId: string): Promise<TriggerCatalogResult> {
  if (!isCatalogEnabled()) {
    return {
      ok: false,
      status: 503,
      error: 'Cataloging is disabled on this deploy (RELEASE_CATALOG_ENABLED is not set).',
    };
  }

  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  const siteUrl = process.env.URL;

  if (!secret || !siteUrl) {
    // Said plainly rather than as a generic 500: this exact configuration gap silently stopped
    // release cataloging from ever running, and "nothing happened" gave no clue why.
    console.error('[catalog] INTERNAL_FUNCTION_SECRET or site URL is not configured');
    return {
      ok: false,
      status: 503,
      error: 'Cataloging is not configured on this deploy (INTERNAL_FUNCTION_SECRET).',
    };
  }

  try {
    // 'saved' is the larger hourly budget, which is right for a deliberate act by a person.
    await fetch(`${siteUrl}/.netlify/functions/catalog-artist-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ artistIds: [artistId], trigger: 'saved' satisfies CatalogTrigger }),
    });
    return { ok: true };
  } catch (error) {
    console.error('[catalog] deliberate trigger failed:', error instanceof Error ? error.message : String(error));
    return { ok: false, status: 502, error: 'Could not reach the cataloging function' };
  }
}
