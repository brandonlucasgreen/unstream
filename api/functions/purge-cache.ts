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
