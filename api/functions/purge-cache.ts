// Netlify CDN cache purge by tag.
//
// The edge functions that server-render artist and release pages cache aggressively (a day for
// the crawler-only artist page, an hour for release pages, which everyone sees). That is only safe
// because the writes that change those pages purge them, so this is the counterpart to the
// `Cache-Tag` headers in api/edge/artist-page-static.ts and api/edge/release-page.ts.
//
// Netlify purges by *exact* tag — there are no wildcards — which is why release pages carry a
// shared `artist-releases-${slug}` tag alongside their own: it's the only way to clear all of one
// artist's release pages in a single call.

import { getClient } from './db';

/**
 * Fire the purge and report what happened, without ever throwing at the caller.
 *
 * A failed purge means a page serves stale for the rest of its TTL, which is worth a log line but
 * never worth failing an artist's edit over — the write already succeeded by the time we get here.
 * No-ops with a warning when the Netlify credentials aren't set, which is the normal state in
 * local dev and tests.
 */
export async function purgeCacheTags(tags: string[], label: string): Promise<void> {
  if (tags.length === 0) return;

  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteId || !token) {
    console.warn(`[${label}] NETLIFY_SITE_ID or NETLIFY_API_TOKEN not set, skipping CDN purge for ${tags.join(', ')}`);
    return;
  }

  try {
    await fetch('https://api.netlify.com/api/v1/purge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: siteId, cache_tags: tags }),
    });
    console.log(`[${label}] Purged CDN cache for ${tags.join(', ')}`);
  } catch (error) {
    console.error(`[${label}] CDN cache purge failed for ${tags.join(', ')}:`, error);
  }
}

/**
 * Everything server-rendered for one artist: their artist page, and every one of their release
 * pages via the tag they all share.
 */
export async function purgeArtistReleaseCaches(slug: string, label = 'PurgeCache'): Promise<void> {
  await purgeCacheTags([`artist-${slug}`, `artist-releases-${slug}`], label);
}

/**
 * Purge one user's shared-list page (`/u/:handle` and its data endpoint) by looking up their
 * handle. The tag is only worth purging when the user has a handle at all — no handle, no
 * public page, nothing cached. Costs one usernames read per *mutation* (hide an item, finish
 * a sync, disconnect), which is what pays for the page itself being CDN-cached per *view*.
 */
export async function purgeUserShareCacheForUser(userId: string, label: string): Promise<void> {
  // Same rule as purgeCacheTags: never throw at the caller. The write this purge follows has
  // already succeeded, and stale-for-the-TTL beats failing a user's action over cache hygiene.
  try {
    const client = getClient();
    if (!client) return;

    const { data, error } = await client
      .from('usernames')
      .select('username')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn(`[${label}] could not resolve handle for share-page purge:`, error.message);
      return;
    }
    const handle = (data as { username: string } | null)?.username;
    if (handle) await purgeCacheTags([`user-share-${handle}`], label);
  } catch (error) {
    console.warn(`[${label}] share-page purge failed:`, error instanceof Error ? error.message : String(error));
  }
}
