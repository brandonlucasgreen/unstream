// The admin's lists that every search reads: merge overrides and link suppressions, with their
// Redis cache and the 60-second in-process memo (the one sanctioned memo; it lives here with
// invalidateAdminListCache, and nowhere else). Also the stored-link checks behind /admin/links.

import { artistSlug } from '../../shared/artist-slug';
import { normalizeUrlForMatch, urlMatchPrefilter } from '../search-utils';
import { cacheDelete, cacheGetOrFetch } from '../cache';
import { getClient } from './client';

// --- Merge Overrides ---

export interface MergeOverrideRow {
  id: string;
  group_name: string;
  platform_urls: string[];
  excluded_urls: string[];
  canonical_image_url: string | null;
}

/**
 * Both admin tables below are read in full on *every search* and change only when an admin acts,
 * which made them two uncached full-table reads on the hottest path in the product. Five minutes
 * in Redis removes them; the admin endpoints invalidate on write (see `invalidateAdminListCache`),
 * so a merge or a suppression still takes effect immediately.
 *
 * The TTL is what covers the CLI (`scripts/merge-override.ts`), which writes the same table
 * without going through a function and has no Redis credentials to invalidate with. A CLI edit
 * lands within five minutes rather than instantly — the reason the TTL is short rather than long.
 */
const ADMIN_LIST_CACHE_TTL = 5 * 60;
const MERGE_OVERRIDES_CACHE_KEY = 'admin:merge-overrides';
const LINK_SUPPRESSIONS_CACHE_KEY = 'admin:link-suppressions';

/**
 * A second, in-process layer in front of the Redis one.
 *
 * Redis turned two full-table reads per search into two Redis reads per search — cheaper, but
 * still two billed Upstash commands on the hottest path, for two lists that are identical for
 * every visitor and change only when an admin acts. A search and the Phase 2 enrichment that
 * follows it read them again seconds apart, on the same warm container, for the same answer.
 *
 * So a warm container remembers the answer for a minute. That is short enough to keep the
 * invalidation story honest — an admin merge still lands everywhere within a minute, where the
 * Redis delete alone made it instant — and long enough that a burst of requests through one
 * container costs one Redis read instead of one per request. `invalidateAdminListCache` clears
 * this container's copy too, so the admin who made the change sees it immediately.
 *
 * Not worth generalising into `cache.ts`: these two lists are the only values in the codebase
 * that are global, tiny, and read on every single search.
 */
const ADMIN_LIST_MEMO_TTL_MS = 60 * 1000;
const adminListMemo = new Map<string, { expiresAt: number; rows: unknown[] }>();

function readAdminListMemo<T>(key: string): T[] | null {
  const entry = adminListMemo.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    adminListMemo.delete(key);
    return null;
  }
  return entry.rows as T[];
}

function writeAdminListMemo<T>(key: string, rows: T[]): void {
  adminListMemo.set(key, { expiresAt: Date.now() + ADMIN_LIST_MEMO_TTL_MS, rows });
}

/** Test seam: drop this process's memoized admin lists. */
export function resetAdminListMemoForTests(): void {
  adminListMemo.clear();
}

/**
 * A read that knows whether it succeeded.
 *
 * Both of these functions return `[]` on failure *and* `[]` when the table is genuinely empty,
 * which is fine for a caller that fails open but is exactly the shape you must not put in a
 * cache — see "Never cache uncertainty" in CLAUDE.md. Caching a failed read would suppress every
 * merge override for a full TTL because Supabase blipped once. So the cached value carries `ok`,
 * and only `ok: true` is written.
 */
interface CachedAdminList<T> {
  ok: boolean;
  rows: T[];
}

export async function invalidateAdminListCache(list: 'merge-overrides' | 'link-suppressions'): Promise<void> {
  const key = list === 'merge-overrides' ? MERGE_OVERRIDES_CACHE_KEY : LINK_SUPPRESSIONS_CACHE_KEY;
  adminListMemo.delete(key);
  await cacheDelete(key);
}

export async function getMergeOverrides(): Promise<MergeOverrideRow[]> {
  const client = getClient();
  if (!client) return [];

  const memoized = readAdminListMemo<MergeOverrideRow>(MERGE_OVERRIDES_CACHE_KEY);
  if (memoized) return memoized;

  const { data } = await cacheGetOrFetch<CachedAdminList<MergeOverrideRow>>(
    MERGE_OVERRIDES_CACHE_KEY,
    async () => {
      try {
        const { data, error } = await client
          .from('artist_merge_overrides')
          .select('id, group_name, platform_urls, excluded_urls, canonical_image_url');

        if (error) {
          console.error('[DB] Failed to fetch merge overrides:', error);
          return { ok: false, rows: [] };
        }

        return { ok: true, rows: (data as MergeOverrideRow[]) || [] };
      } catch (error) {
        console.error('[DB] getMergeOverrides error:', error);
        return { ok: false, rows: [] };
      }
    },
    ADMIN_LIST_CACHE_TTL,
    result => result.ok
  );

  // Only memoize a read that succeeded — same rule as the Redis layer, for the same reason.
  // Remembering a failed read for a minute would suppress every merge override for a minute
  // because Supabase blipped once.
  if (data.ok) writeAdminListMemo(MERGE_OVERRIDES_CACHE_KEY, data.rows);

  return data.rows;
}

// --- Platform link suppressions ---

export interface LinkSuppressionRow {
  id: string;
  url: string;
  source_id: string | null;
  artist_name: string | null;
  artist_name_norm: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Admin decisions of the form "this URL does not belong on this artist".
 *
 * Returns [] on any failure, like getMergeOverrides — a suppression list that
 * can't be read must not take the search response down with it. The cost of
 * failing open is that a known-bad link reappears until the next request.
 */
export async function getLinkSuppressions(): Promise<
  Pick<LinkSuppressionRow, 'url' | 'artist_name_norm'>[]
> {
  type Row = Pick<LinkSuppressionRow, 'url' | 'artist_name_norm'>;

  const client = getClient();
  if (!client) return [];

  const memoized = readAdminListMemo<Row>(LINK_SUPPRESSIONS_CACHE_KEY);
  if (memoized) return memoized;

  const { data } = await cacheGetOrFetch<CachedAdminList<Row>>(
    LINK_SUPPRESSIONS_CACHE_KEY,
    async () => {
      try {
        const { data, error } = await client
          .from('platform_link_suppressions')
          .select('url, artist_name_norm');

        if (error) {
          console.error('[DB] Failed to fetch link suppressions:', error);
          return { ok: false, rows: [] };
        }

        return { ok: true, rows: (data as Row[]) || [] };
      } catch (error) {
        console.error('[DB] getLinkSuppressions error:', error);
        return { ok: false, rows: [] };
      }
    },
    ADMIN_LIST_CACHE_TTL,
    result => result.ok
  );

  // As above: never memoize a read that failed.
  if (data.ok) writeAdminListMemo(LINK_SUPPRESSIONS_CACHE_KEY, data.rows);

  return data.rows;
}

/**
 * Delete stored copies of a link from artist_links.
 *
 * Suppressing a link filters it out of search responses, but past searches may
 * already have persisted it (persistSearchResults / persistEnrichment), and the
 * artist page reads artist_links directly — so without this the bad link stays
 * visible at /a/:slug. Scoped to one artist when artistName is given.
 *
 * Best-effort: returns the number of rows deleted, 0 on any failure. The
 * suppression itself is what guarantees the link stays out of search results.
 */
export async function deleteStoredLinksForUrl(url: string, artistName: string | null): Promise<number> {
  const client = getClient();
  if (!client) return 0;

  const target = normalizeUrlForMatch(url);
  // Coarse prefilter on host+path so rows stored as http://, https:// or with a
  // www. prefix are all candidates; ilike treats % and _ as wildcards, and a URL
  // may legitimately contain either.
  const pattern = `%${urlMatchPrefilter(url).replace(/[%_\\]/g, m => `\\${m}`)}%`;

  try {
    let artistId: string | null = null;
    if (artistName) {
      const { data: artist } = await client
        .from('artists')
        .select('id')
        .eq('slug', artistSlug(artistName))
        .single();
      // No stored artist row means nothing to clean up for this scope.
      if (!artist) return 0;
      artistId = (artist as { id: string }).id;
    }

    let query = client.from('artist_links').select('id, url').ilike('url', pattern);
    if (artistId) query = query.eq('artist_id', artistId);
    const { data, error } = await query;

    if (error) {
      console.error('[DB] Failed to look up stored links for suppression:', error);
      return 0;
    }

    // The ilike above is a filter, not the decision — compare match keys so
    // `.../music` isn't deleted along with `...`.
    const ids = ((data as { id: string; url: string }[]) || [])
      .filter(row => normalizeUrlForMatch(row.url) === target)
      .map(row => row.id);
    if (ids.length === 0) return 0;

    const { error: deleteError } = await client.from('artist_links').delete().in('id', ids);
    if (deleteError) {
      console.error('[DB] Failed to delete stored links for suppression:', deleteError);
      return 0;
    }

    return ids.length;
  } catch (error) {
    console.error('[DB] deleteStoredLinksForUrl error:', error);
    return 0;
  }
}

/**
 * Is this URL already stored as a platform link for this artist?
 *
 * Containment for outbound fetches that a hostname allowlist can't express. Faircamp is
 * self-hosted on arbitrary domains (music.someartist.com), so `isUrlHostnameAllowed` —
 * which only admits hostnames with a literal `faircamp` label — rejects most genuine
 * Faircamp sites. Requiring the URL to be one we already discovered and persisted gives
 * the same "you can't point us at anything you like" guarantee without breaking the
 * platform.
 *
 * Fails closed: a missing client, a query error, or an unknown artist all return false,
 * because the caller uses this to decide whether to make a request on a stranger's behalf.
 */
export async function isStoredArtistLink(url: string, artistName: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  const target = normalizeUrlForMatch(url);
  // Coarse prefilter on host+path so rows stored as http://, https:// or with a www.
  // prefix are all candidates; ilike treats % and _ as wildcards, and a URL may
  // legitimately contain either.
  const pattern = `%${urlMatchPrefilter(url).replace(/[%_\\]/g, m => `\\${m}`)}%`;

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id')
      .eq('slug', artistSlug(artistName))
      .maybeSingle();

    if (artistError) {
      console.error('[DB] isStoredArtistLink artist lookup failed:', artistError.message);
      return false;
    }
    if (!artist) return false;

    const { data, error } = await client
      .from('artist_links')
      .select('url')
      .eq('artist_id', (artist as { id: string }).id)
      .ilike('url', pattern);

    if (error) {
      console.error('[DB] isStoredArtistLink link lookup failed:', error.message);
      return false;
    }

    // The ilike is a prefilter, not the decision — compare normalized match keys so a
    // stored `.../music` doesn't authorize fetching an unrelated deeper path.
    return ((data as { url: string }[]) || []).some(
      row => normalizeUrlForMatch(row.url) === target
    );
  } catch (error) {
    console.error('[DB] isStoredArtistLink error:', error);
    return false;
  }
}
