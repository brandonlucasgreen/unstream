// CDN cache purge by tag.
//
// The pages that server-render artist and release data set long CDN TTLs (a day for the
// crawler-only artist page, an hour for release pages, which everyone sees). That is only safe
// because the writes that change those pages purge them, so this is the counterpart to the
// `Cache-Tag` headers in api/edge/artist-page-static.ts and api/edge/release-page.ts. Only the
// release page is actually cached; see the note on CDN_CACHE_CONTROL in artist-page-static.
//
// Both CDNs purge by *exact* tag — there are no wildcards — which is why release pages carry a
// shared `artist-releases-${slug}` tag alongside their own: it's the only way to clear all of one
// artist's release pages in a single call.
//
// **Both are purged while both can be serving.** Netlify is production until the cutover and
// stays up for two weeks afterwards as the rollback path, so a purge that only reached one of
// them would leave stale pages behind on the other — and the rollback is exactly the moment
// nobody would be watching for it. Each is tried only when its own credentials are set, so
// whichever is configured is the one that gets purged. Drop the Netlify half when that site is
// retired.

import { getClient } from './db';
import { isUrlHostnameAllowed } from './middleware';

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

  const purged = (await Promise.all([purgeNetlify(tags, label), purgeCloudflare(tags, label)])).filter(Boolean);

  if (purged.length === 0) {
    console.warn(`[${label}] no CDN purge credentials set, skipping purge for ${tags.join(', ')}`);
    return;
  }
  console.log(`[${label}] Purged ${purged.join(' and ')} cache for ${tags.join(', ')}`);
}

/** Netlify's purge endpoint. Constant, and on ALLOWED_OUTBOUND_HOSTNAMES. */
const NETLIFY_PURGE_URL = 'https://api.netlify.com/api/v1/purge';

/** Returns the CDN's name when it was asked to purge, or null when it isn't configured. */
async function purgeNetlify(tags: string[], label: string): Promise<string | null> {
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteId || !token) return null;

  if (!isUrlHostnameAllowed(NETLIFY_PURGE_URL)) {
    console.error(`[${label}] Netlify purge host is not on the outbound allowlist`);
    return null;
  }

  try {
    const response = await fetch(NETLIFY_PURGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: siteId, cache_tags: tags }),
    });
    if (!response.ok) {
      console.error(`[${label}] Netlify purge refused (HTTP ${response.status}) for ${tags.join(', ')}`);
      return null;
    }
    return 'Netlify';
  } catch (error) {
    console.error(`[${label}] Netlify purge failed for ${tags.join(', ')}:`, error);
    return null;
  }
}

/**
 * Cloudflare's purge-by-tag. Available on every plan since April 2025 — it used to be
 * Enterprise-only, and most of what's written about it still says so.
 *
 * Rate-limited per plan, and a refusal is reported rather than swallowed: a purge that is being
 * throttled looks exactly like a purge that worked, and the symptom — an artist's edit not
 * showing for an hour — is the kind of thing that gets blamed on the edit instead.
 */
async function purgeCloudflare(tags: string[], label: string): Promise<string | null> {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  if (!zoneId || !token) return null;

  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
  if (!isUrlHostnameAllowed(url)) {
    console.error(`[${label}] Cloudflare purge host is not on the outbound allowlist`);
    return null;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) {
      const detail = response.status === 429 ? ' (rate limited)' : '';
      console.error(`[${label}] Cloudflare purge refused (HTTP ${response.status})${detail} for ${tags.join(', ')}`);
      return null;
    }
    return 'Cloudflare';
  } catch (error) {
    console.error(`[${label}] Cloudflare purge failed for ${tags.join(', ')}:`, error);
    return null;
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
