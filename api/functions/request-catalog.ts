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

  const secret = process.env.INTERNAL_FUNCTION_SECRET;

  // DEPLOY_PRIME_URL first, not URL. On Netlify, URL is the *production* address even during
  // a deploy preview, so preferring it would make a preview invoke the production function —
  // running production code for a preview's traffic and spending the shared hourly crawl
  // budget. DEPLOY_PRIME_URL is the current deploy (preview, branch, or production), which is
  // what we want in every context.
  const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL;

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
