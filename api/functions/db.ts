// Supabase database module for the Unstream artist database.
// All operations are optional — if Supabase is not configured, they no-op gracefully.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  foldToAscii,
  isBandcampSearchLink,
  normalizeUrlForMatch,
  urlMatchPrefilter,
} from './search-utils';
import {
  deriveStatus,
  findExactReleaseMatch,
  findFuzzyReleaseMatch,
  mapReleaseType,
  parseReleaseDate,
  releaseMatchKey,
  uniqueReleaseSlug,
} from './release-utils';
import { oneSourcePerPlatform } from '../shared/release-display';
import { cacheDelete, cacheGetOrFetch } from './cache';
import { notifySavedArtistsOfNewRelease } from './notifications';
import { Sentry } from '../lib/sentry';
import { isNonArtistSlug } from '../lib/non-artist-names';
import { isExcludedArtistSlug } from '../lib/excluded-artists';

let supabase: SupabaseClient | null = null;

export function getClient(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

/**
 * Generate a URL-safe slug from an artist name.
 *
 * Accents are **folded, not stripped**. The old version ran the raw name through
 * `[^a-z0-9]+ -> '-'`, which mangled every accented artist into something unfindable:
 *
 *   Björk             -> bj-rk               (now bjork)
 *   Sébastien Tellier -> s-bastien-tellier   (now sebastien-tellier)
 *   Hüsker Dü         -> h-sker-d            (now husker-du)
 *   Łukasz            -> ukasz               (now lukasz — the Ł used to vanish outright)
 *
 * Fans reported being unable to find accented artists, and it was worse than an ugly URL: the
 * mangled form is what `persistSearchResults` upserts `on conflict (slug)`, so an artist typed with
 * accents and one typed without produced two rows and two half-populated pages.
 *
 * **Changing this changes what an existing artist's slug computes to**, which is why
 * `artist_slug_aliases` exists — a row whose stored slug is the old mangled form has to be
 * re-slugged and its old slug aliased, or the next search creates a third row. See
 * `scripts/merge-duplicate-artists.ts` and migration 20260803180000.
 */
export function artistSlug(name: string): string {
  return foldToAscii(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Determine if a platform URL is a direct link (not a search URL).
// Exported so scripts/backfill-published-artist-rows.ts stores exactly what a search would store.
//
// This is not only a label: persistSearchResults filters on it, so it decides which links get a
// row at all. `bandcamp.com/search` is listed because it did not used to be — the search-link
// fallback that produced it is gone now, but 189 rows reached the database through this gate
// first, and the crawler then treated every one of them as an artist page (#407).
//
// `subvert.fm/discover` is the same mistake caught later: Subvert is `searchOnly: true` in
// sources.ts and its `searchUrlTemplate` IS that discover URL, so every search-discovered Subvert
// "link" was the search box — 321 of the 349 stored. The other 28 are real `subvert.fm/<handle>`
// pages that artists added themselves, which is why this matches the /discover path and not the
// host: excluding the platform would delete those.
export function isDirectLink(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.includes('duckduckgo.com') &&
    !lower.includes('google.com/search') &&
    !lower.includes('bandcamp.com/search') &&
    !lower.includes('subvert.fm/discover') &&
    !lower.includes('searchstyle=search') &&
    !lower.includes('explore-creators')
  );
}

// Platforms that are manual search links, not real artist presences.
// Exported alongside isDirectLink for the same reason — see above.
export const EXCLUDED_PLATFORMS = new Set(['buymeacoffee', 'kofi', 'ampwall']);

// How long before artist data is considered stale (24 hours)
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How often a search is allowed to touch an artist row that hasn't actually changed.
 *
 * `persistSearchResults` used to upsert the `artists` row on *every* search, always stamping
 * `updated_at` — so searching an artist we already knew perfectly still rewrote the row. Postgres
 * has no in-place update: each write is a new tuple version plus an entry in all five of this
 * table's indexes, one of which is a GIN trigram index on `name`. It was the hottest path in the
 * product doing pure write churn, and a contributor to the Disk IO Budget alert.
 *
 * **It cannot simply be skipped when nothing changed, though**, because `updated_at` on this table
 * does not mean "when the data changed" — `getArtistBySlug` reads it as "when we last verified
 * this artist against live sources" and refuses the row once it passes FRESHNESS_TTL_MS. Stop
 * advancing it and stored cards silently expire, so every search re-runs the full live pipeline:
 * cheaper on Postgres, much more expensive everywhere else, and a behaviour change nobody asked
 * for. (search-sources.ts makes the same point from the other direction: DB-served cards are
 * deliberately excluded from persist so re-serving stored data can't refresh `updated_at` and
 * mask genuine staleness.)
 *
 * So the write is *throttled*, not removed: an unchanged row is refreshed at most once an hour.
 * Well inside the 24-hour freshness window, so no row can expire because of this, while N searches
 * for the same artist within the hour collapse into one write instead of N.
 *
 * Keep this comfortably below FRESHNESS_TTL_MS. Raising it towards 24 hours would start letting
 * rows expire between refreshes.
 */
const PERSIST_REFRESH_FLOOR_MS = 60 * 60 * 1000;

/**
 * Whether a search needs to write to an artist row it already found.
 *
 * True when the row would actually change, or when it is due a freshness refresh. False means the
 * write is pure churn and is skipped.
 */
function artistNeedsRefresh(
  existing: { name: string | null; image_url: string | null; match_confidence: string | null; updated_at: string | null },
  name: string,
  imageUrl: string | null,
  matchConfidence: string
): boolean {
  if (existing.name !== name) return true;
  if (existing.image_url !== imageUrl) return true;
  if (existing.match_confidence !== matchConfidence) return true;

  // An unparseable or missing timestamp is treated as due, so a bad value can't pin a row
  // permanently unrefreshed — the failure mode has to be "one extra write", never "never again".
  if (!existing.updated_at) return true;
  const updatedAt = new Date(existing.updated_at).getTime();
  if (Number.isNaN(updatedAt)) return true;

  return Date.now() - updatedAt > PERSIST_REFRESH_FLOOR_MS;
}

// --- Types matching the search-sources response ---

interface PlatformLink {
  sourceId: string;
  url: string;
  // Custom label an artist set in the profile editor (artist_links.display_name).
  // Only "other" links normally carry one; search-discovered links leave it null.
  displayName?: string;
  latestRelease?: {
    title: string;
    type: 'album' | 'track';
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
  allReleaseTitles?: string[];
}

interface ArtistProfile {
  bio?: string;
  customImageUrl?: string;
  websiteUrl?: string;
  featuredEmbed?: string;
  verified: boolean;
  // Divider positions in the artist's link order — see api/shared/link-dividers.ts.
  // Carried here so the artist edit page can rebuild the arrangement it saved.
  linkDividers?: number[];
}

interface ArtistResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  matchConfidence?: 'verified' | 'unverified' | 'claimed';
  profile?: ArtistProfile;
  location?: { city?: string; country?: string; countryCode?: string };
}

// --- DB Row Types ---

interface ArtistRow {
  id: string;
  slug: string;
  name: string;
  image_url: string | null;
  match_confidence: string | null;
  source: string;
  updated_at: string;
  last_enriched_at: string | null;
  city: string | null;
  country: string | null;
  country_code: string | null;
}

interface LinkRow {
  id: string;
  artist_id: string;
  platform: string;
  url: string;
  display_name: string | null;
  source: string;
  is_direct: boolean;
  latest_release: Record<string, unknown> | null;
  display_order: number | null;
}

// --- Artist Profile Bundle ---

export interface ArtistProfileRow {
  bio: string | null;
  custom_image_url: string | null;
  featured_embed: string | null;
  verified_at: string | null;
  link_dividers: number[] | null;
}

export interface ArtistProfileBundle {
  artist: ArtistRow;
  profile: ArtistProfileRow | null;
  links: LinkRow[];
}

/**
 * Fetch the artist row + profile row + links for an artist.
 *
 * Three outcomes, deliberately distinguishable — a caller that can't tell "no such artist" from
 * "the database didn't answer" turns an outage into a page full of 404s that look like the truth:
 *   { bundle }            — found
 *   { bundle: null }      — no artist row with this slug
 *   { failed: true }      — the lookup itself failed (no client, query error, exception)
 */
export interface ArtistProfileLookup {
  bundle: ArtistProfileBundle | null;
  failed: boolean;
}

export async function getArtistProfileBySlug(slug: string): Promise<ArtistProfileLookup> {
  const client = getClient();
  // No service-role client means the credentials are missing, not that the artist is missing.
  if (!client) return { bundle: null, failed: true };

  try {
    // Find the artist row first. maybeSingle() rather than single(): single() reports "0 rows" as
    // an error, which is what made a genuine absence indistinguishable from a real failure.
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (artistError) return { bundle: null, failed: true };
    if (!artist) return { bundle: null, failed: false };

    // Deliberately no `match_confidence === 'claimed'` filter. Unclaimed artists have a real row
    // and real links, and /artist/:slug renders them as the quiet card — the same page the
    // artist-page-static edge function serves crawlers, which has never had this filter either.
    // Gating here 404'd every unclaimed artist page for anyone running JS (see #369).
    const artistRow = artist as ArtistRow;
    const artistId = artistRow.id;

    // Fetch profile and links in parallel
    const [profileResult, linksResult] = await Promise.all([
      client
        .from('artist_profiles')
        .select('bio, custom_image_url, featured_embed, verified_at, link_dividers')
        .eq('artist_id', artistId)
        .single(),
      client
        .from('artist_links')
        .select('*')
        .eq('artist_id', artistId)
        .order('display_order', { ascending: true, nullsFirst: false }),
    ]);

    return {
      bundle: {
        artist: artistRow,
        profile: (profileResult.data as ArtistProfileRow | null) ?? null,
        links: (linksResult.data as LinkRow[]) || [],
      },
      failed: false,
    };
  } catch (error) {
    console.error('[DB] getArtistProfileBySlug error:', error);
    return { bundle: null, failed: true };
  }
}

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

// --- Release catalog (Unstream Releases) ---

/** Don't re-crawl an artist inside this window. Repeat searches then cost nothing upstream. */
export const RECATALOG_COOLDOWN_HOURS = 24 * 7;

/**
 * Hourly ceilings on how many artists we will catalog, by what triggered it.
 *
 * A save is one person deliberately asking to follow an artist, so it gets the biggest budget
 * and still gets through when the scheduled sweep is being dropped. The sweep sits below it:
 * the cap is compared against every attempt in the last hour whatever triggered it, so a
 * machine caller must never outrank a person, but the sweep runs at a fixed time and can't
 * wait for a quieter moment, so it can't have the smallest either.
 *
 * `searched` has no caller any more — `persistSearchResults` no longer requests cataloging,
 * because an unauthenticated, traffic-driven trigger at 60 first-time crawls an hour was what
 * exhausted the Supabase disk I/O budget (see that function's comment). The entry stays because
 * it is the fail-closed default the background function falls back to for an unrecognized
 * trigger, and it is the smallest budget of the three. Adding a caller back means re-doing the
 * arithmetic in docs/specs/supabase-disk-io-investigation.md first.
 */
const CATALOG_HOURLY_CAP = { searched: 60, saved: 240, scheduled: 120 } as const;

export type CatalogTrigger = 'saved' | 'searched' | 'scheduled';

/**
 * May we catalog this artist right now — and if so, claim it.
 *
 * Cooldown, then hourly cap, then stamp `last_attempted_at`. The stamp is the claim: two
 * near-simultaneous triggers for the same artist won't both do the work, because the second
 * sees a fresh attempt timestamp.
 *
 * Returns false on any error. Cataloging is opportunistic — if we can't tell whether it's
 * allowed, not crawling is the safe answer, and the next search or save tries again.
 */
export async function claimArtistForCatalog(
  artistId: string,
  trigger: CatalogTrigger
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data: state, error: stateError } = await client
      .from('release_catalog_state')
      .select('last_catalogued_at, last_attempted_at, consecutive_failures')
      .eq('artist_id', artistId)
      .maybeSingle();

    if (stateError) {
      console.error('[DB] claimArtistForCatalog read failed:', stateError.message);
      return false;
    }

    const now = Date.now();
    const row = state as
      | { last_catalogued_at: string | null; last_attempted_at: string; consecutive_failures: number }
      | null;

    if (row) {
      // Already catalogued recently.
      if (row.last_catalogued_at) {
        const age = now - new Date(row.last_catalogued_at).getTime();
        if (age < RECATALOG_COOLDOWN_HOURS * 3600_000) return false;
      }

      // Someone else claimed it moments ago, or a failing artist is backing off. The backoff
      // doubles per consecutive failure so a permanently broken artist isn't retried on every
      // single search, capped so it eventually recovers.
      const attemptAge = now - new Date(row.last_attempted_at).getTime();
      const backoffMs = Math.min(2 ** Math.min(row.consecutive_failures, 6), 64) * 15 * 60_000;
      if (attemptAge < Math.max(backoffMs, 60_000)) return false;
    }

    // Hourly cap, counted across all artists.
    const since = new Date(now - 3600_000).toISOString();
    const { count, error: countError } = await client
      .from('release_catalog_state')
      .select('artist_id', { count: 'exact', head: true })
      .gte('last_attempted_at', since);

    if (countError) {
      console.error('[DB] claimArtistForCatalog count failed:', countError.message);
      return false;
    }
    if ((count ?? 0) >= CATALOG_HOURLY_CAP[trigger]) {
      console.log(`[catalog] hourly cap reached for trigger=${trigger} (${count}) — skipping`);
      return false;
    }

    const { error: claimError } = await client
      .from('release_catalog_state')
      .upsert(
        { artist_id: artistId, last_attempted_at: new Date(now).toISOString(), last_trigger: trigger },
        { onConflict: 'artist_id' }
      );

    if (claimError) {
      console.error('[DB] claimArtistForCatalog claim failed:', claimError.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DB] claimArtistForCatalog error:', error);
    return false;
  }
}

/** Record the outcome of a catalog run. Failures increment the backoff counter. */
export async function recordCatalogOutcome(
  artistId: string,
  outcome: { releasesFound: number; releasesDetailed?: number } | { error: string }
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const patch: Record<string, unknown> =
    'error' in outcome
      ? { last_error: outcome.error.slice(0, 500) }
      : {
          last_catalogued_at: new Date().toISOString(),
          releases_found: outcome.releasesFound,
          releases_detailed: outcome.releasesDetailed ?? 0,
          consecutive_failures: 0,
          last_error: null,
        };

  try {
    if ('error' in outcome) {
      // Read-then-increment rather than a raw SQL expression, to stay within the JS client.
      const { data } = await client
        .from('release_catalog_state')
        .select('consecutive_failures')
        .eq('artist_id', artistId)
        .maybeSingle();
      const prev = (data as { consecutive_failures: number } | null)?.consecutive_failures ?? 0;
      patch.consecutive_failures = prev + 1;
    } else {
      // Read once and branch: a drop to zero is a parser/bot-challenge alert (see below), an
      // increase is news for anyone who saved this artist. Fetched for every successful run,
      // not just the sweep, since demand-driven catalog triggers (a save, a search) are exactly
      // where a fan is most likely to be waiting on this.
      const { data } = await client
        .from('release_catalog_state')
        .select('releases_found')
        .eq('artist_id', artistId)
        .maybeSingle();
      const previous = (data as { releases_found: number | null } | null)?.releases_found ?? 0;

      if (outcome.releasesFound === 0 && previous > 0) {
        // A run that finds 0 releases where it previously found 20 is a parser break or a bot
        // challenge, not an artist deleting their catalogue — and it is recorded as a *success*,
        // so nothing else about it looks wrong. Report the transition, because the alternative
        // is a pipeline that degrades into finding nothing and never says so.
        //
        // Only the transition: an artist who has always had 0 releases is not news, and this
        // fires on every trigger, not just the scheduled sweep.
        Sentry.captureMessage('[catalog] release count dropped to zero', {
          level: 'warning',
          tags: { area: 'release-catalog', kind: 'releases-dropped-to-zero' },
          extra: { artistId, previousReleasesFound: previous },
        });
      } else if (outcome.releasesFound > previous) {
        // Fire-and-forget: notifySavedArtistsOfNewRelease decides for itself whether there is
        // anything to say (it sends nothing unless this run turned up a release that is both
        // unannounced and actually recent) and logs its own failures to Sentry — a notification
        // email must never affect cataloging's own success/failure. The count comparison here is
        // only a cheap gate: a total that didn't go up can't have added rows worth claiming.
        void notifySavedArtistsOfNewRelease({ client, artistId }).catch(err => {
          Sentry.captureException(err, { extra: { context: 'notifySavedArtistsOfNewRelease', artistId } });
        });
      }
    }

    const { error } = await client
      .from('release_catalog_state')
      .update(patch)
      .eq('artist_id', artistId);

    if (error) console.error('[DB] recordCatalogOutcome failed:', error.message);
  } catch (error) {
    console.error('[DB] recordCatalogOutcome error:', error);
  }
}

export interface CatalogStateRow {
  last_catalogued_at: string | null;
  last_attempted_at: string;
  releases_found: number | null;
  releases_detailed: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/**
 * Deliberately three-valued, not two. "We couldn't ask" and "we asked and this artist has never
 * been catalogued" are different facts, and collapsing them into one `null` makes a broken
 * database read render as a confident "Never catalogued" — the same shape as the bug class the
 * "never cache uncertainty" principle exists to prevent. Every surface that reports cataloging
 * exists to make it observable, so an unreadable state has to say so rather than guess.
 */
export type CatalogStateResult =
  | { ok: true; state: CatalogStateRow | null }
  | { ok: false; reason: string };

export async function getCatalogState(artistId: string): Promise<CatalogStateResult> {
  const client = getClient();
  if (!client) return { ok: false, reason: 'Supabase is not configured on this deploy' };

  const { data, error } = await client
    .from('release_catalog_state')
    .select('last_catalogued_at, last_attempted_at, releases_found, releases_detailed, last_error, consecutive_failures')
    .eq('artist_id', artistId)
    .maybeSingle();

  if (error) {
    console.error('[DB] getCatalogState failed:', error.message);
    return { ok: false, reason: 'Could not read catalog state' };
  }
  return { ok: true, state: (data as CatalogStateRow | null) ?? null };
}

/** One artist the scheduled sweep could crawl, with the facts it was chosen on. */
export interface StaleCatalogCandidate {
  artistId: string;
  /** Somebody has this artist saved, so an alert depends on this catalogue being current. */
  saved: boolean;
  /** How many people have them saved. A tiebreak only — see the sort below. */
  savers: number;
  /** Null means no catalog run has ever claimed them: this is coverage, not refresh. */
  lastAttemptedAt: string | null;
  /** What the last successful run found, so a sweep run can be read against it afterwards. */
  releasesFound: number | null;
}

/**
 * Three-valued for the same reason as `CatalogStateResult`: "we couldn't ask" must not render
 * as "nothing needs re-cataloguing". The sweep reports the first as a failure and the second as
 * a quiet, successful run, and they look identical if collapsed.
 */
export type StaleCatalogResult =
  | {
      ok: true;
      candidates: StaleCatalogCandidate[];
      /** Artists with something to crawl — the pool, not the batch. */
      catalogueable: number;
      /** How many of those are saved by somebody. */
      savedArtists: number;
      /** Dropped because they were catalogued inside the cooldown. */
      inCooldown: number;
      /** Eligible right now, of which only `limit` fit in this batch. */
      eligible: number;
    }
  | { ok: false; reason: string };

/**
 * The platforms `catalogArtist` can actually crawl.
 *
 * Deliberately **not** including `officialsite`: that link is only followed to *discover* other
 * platforms, and `catalogArtist` treats an artist with nothing but an official site as having
 * "no bandcamp, discogs, faircamp, jam.coop, or mirlo link stored" — which it records as an
 * **error**, incrementing `consecutive_failures` and writing `last_error`. Keep this list
 * identical to that condition or the sweep will spend its batch on artists with nothing to fetch
 * and turn the failure counters into noise.
 */
const CATALOGUEABLE_PLATFORMS = ['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'mirlo'] as const;

/**
 * Whether a stored link is something the catalog pass can actually crawl.
 *
 * The platform being catalogue-able is not enough: a `bandcamp` row may hold
 * `https://bandcamp.com/search?q=<name>`, the "go search Bandcamp yourself" placeholder that
 * `attachAmpwallAndSearchLinks` writes when nothing resolved a real artist page. It is a UI
 * affordance, not an artist link, and `bandcampMusicUrl()` reduces any URL to its origin plus
 * `/music` — so every one of them derives `https://bandcamp.com/music`, which 404s. Measured
 * 2026-08-03: 189 such rows, and the 16 that had been swept were the *only* failures in
 * `release_catalog_state`, each climbing a backoff it could never escape.
 *
 * Used by both `getStaleCatalogCandidates` and `getArtistForCatalog` so the sweep's pool and
 * `catalogArtist`'s "is there anything to fetch" check cannot disagree about who is worth a run.
 */
function isCatalogueableLink(platform: string, url: string): boolean {
  if (platform === 'bandcamp') return !isBandcampSearchLink(url);
  return true;
}

/**
 * Read a whole table through PostgREST, a page at a time.
 *
 * **`.limit(n)` does not do this.** PostgREST caps every response at its configured `max-rows`
 * (1,000 on this project) regardless of the limit asked for, and it truncates *silently* — the
 * rows simply aren't there. A single `.select()` over `artist_links` returns 1,000 of ~3,900
 * rows and looks perfectly successful, which would quietly hide three quarters of the sweep's
 * pool. Measured on production 2026-08-02.
 *
 * Exported because the cap is not the sweep's problem, it's every read's problem: use this for
 * any query whose table can exceed 1,000 rows, and pass the caller's own `.range(from, to)`.
 */
export async function readAllPages<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string
): Promise<{ ok: true; rows: T[] } | { ok: false; reason: string }> {
  const PAGE = 1_000;
  /** A backstop against an unbounded loop, not an expected ceiling. */
  const MAX_PAGES = 50;
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) {
      console.error(`[DB] ${label} read failed:`, error.message);
      return { ok: false, reason: `Could not read ${label}: ${error.message}` };
    }
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { ok: true, rows };
  }

  // Hitting this means the table outgrew the backstop. Say so rather than returning a truncated
  // pool that reads as complete — the whole point of this helper.
  console.error(`[DB] ${label} exceeded ${MAX_PAGES * PAGE} rows; refusing a truncated read`);
  return { ok: false, reason: `${label} is larger than this read can page through` };
}

/**
 * The artists whose release catalogue most needs building or refreshing.
 *
 * **The pool is every artist with something to crawl, not just saved artists.** It was
 * saved-only when this shipped, on the reasoning that a save is what makes someone expect an
 * alert. The numbers killed that: 9 distinct saved artists against 2,564 with a catalogue-able
 * link, so the sweep's entire universe fit inside a single batch and it would have sat idle
 * almost every run. Alerts are also not the only consumer — `/a/:slug` renders a release list
 * for any catalogued artist, and those pages exist because somebody *searched*, so a stale
 * catalogue there is a visibly out-of-date artist page.
 *
 * Ordering, in priority order:
 *
 *   1. **Saved artists first.** An alert is a promise to a person, so they can never starve
 *      behind the backfill of everyone else. There are few enough of them that this costs the
 *      rest of the pool almost nothing.
 *   2. **Then never catalogued.** No state row at all means we have no releases for them, which
 *      is worse than having slightly old ones.
 *   3. **Then stalest `last_attempted_at`.** Staleness is what makes alerts go quiet and artist
 *      pages go out of date, so it is what the sweep is for.
 *   4. **Then most savers.** A tiebreak only. Sorting by popularity any higher would starve
 *      exactly the long tail this exists to serve — popular artists already stay fresh because
 *      people search them.
 *
 * Artists inside the re-catalog cooldown are dropped here rather than left for
 * `claimArtistForCatalog` to refuse. That's not a second rate limiter — the same constant, read
 * up front — it's what stops a bounded batch being spent entirely on artists that will be
 * refused a moment later. The claim remains the authority; this only decides who to ask about.
 */
export async function getStaleCatalogCandidates(limit: number): Promise<StaleCatalogResult> {
  const client = getClient();
  if (!client) return { ok: false, reason: 'Supabase is not configured on this deploy' };

  const links = await readAllPages<{ artist_id: string | null; platform: string; url: string }>(
    (from, to) =>
      client
        .from('artist_links')
        .select('artist_id, platform, url')
        .in('platform', CATALOGUEABLE_PLATFORMS as unknown as string[])
        .range(from, to),
    'catalogue-able artist links'
  );
  if (!links.ok) return links;

  // One artist commonly has several of these platforms, so this is a set, not a count.
  const pool = new Set<string>();
  for (const row of links.rows) {
    if (!row.artist_id) continue;
    if (!isCatalogueableLink(row.platform, row.url)) continue;
    pool.add(row.artist_id);
  }

  if (pool.size === 0) {
    return { ok: true, candidates: [], catalogueable: 0, savedArtists: 0, inCooldown: 0, eligible: 0 };
  }

  // `deleted` is a tombstone, not a hard delete (migration 017) — an unsaved artist keeps a row
  // so other devices can prune it, and re-crawling for someone who unsaved them is waste.
  const saved = await readAllPages<{ artist_id: string | null }>(
    (from, to) =>
      client
        .from('saved_artists')
        .select('artist_id')
        .eq('deleted', false)
        .not('artist_id', 'is', null)
        .range(from, to),
    'saved artists'
  );
  if (!saved.ok) return saved;

  const savers = new Map<string, number>();
  for (const row of saved.rows) {
    if (row.artist_id) savers.set(row.artist_id, (savers.get(row.artist_id) ?? 0) + 1);
  }

  interface StateRow {
    artist_id: string;
    last_attempted_at: string | null;
    last_catalogued_at: string | null;
    releases_found: number | null;
  }

  // The whole table rather than an `in()` filter per chunk of ids: it holds one row per artist
  // ever attempted, so it is bounded by the same population and paging it is fewer round trips.
  const stateRows = await readAllPages<StateRow>(
    (from, to) =>
      client
        .from('release_catalog_state')
        .select('artist_id, last_attempted_at, last_catalogued_at, releases_found')
        .range(from, to),
    'catalog state'
  );
  if (!stateRows.ok) return stateRows;

  const state = new Map<string, StateRow>();
  for (const row of stateRows.rows) state.set(row.artist_id, row);

  const cooldownCutoff = Date.now() - RECATALOG_COOLDOWN_HOURS * 3600_000;
  const candidates: StaleCatalogCandidate[] = [];
  let inCooldown = 0;

  for (const artistId of pool) {
    const row = state.get(artistId);
    if (row?.last_catalogued_at && new Date(row.last_catalogued_at).getTime() > cooldownCutoff) {
      inCooldown++;
      continue;
    }
    const count = savers.get(artistId) ?? 0;
    candidates.push({
      artistId,
      saved: count > 0,
      savers: count,
      lastAttemptedAt: row?.last_attempted_at ?? null,
      releasesFound: row?.releases_found ?? null,
    });
  }

  candidates.sort((a, b) => {
    if (a.saved !== b.saved) return a.saved ? -1 : 1;
    if (a.lastAttemptedAt === null || b.lastAttemptedAt === null) {
      if (a.lastAttemptedAt !== b.lastAttemptedAt) return a.lastAttemptedAt === null ? -1 : 1;
    } else {
      // Compared as instants, not strings: PostgREST timestamps can differ in offset notation.
      const diff = new Date(a.lastAttemptedAt).getTime() - new Date(b.lastAttemptedAt).getTime();
      if (diff !== 0) return diff;
    }
    return b.savers - a.savers;
  });

  return {
    ok: true,
    candidates: candidates.slice(0, limit),
    catalogueable: pool.size,
    savedArtists: [...savers.keys()].filter(id => pool.has(id)).length,
    inCooldown,
    eligible: candidates.length,
  };
}

/**
 * Clear an artist's cooldown so a deliberately-requested crawl actually runs.
 *
 * Without it a "catalog now" control would appear to work and do nothing for a week —
 * `claimArtistForCatalog` refuses an artist catalogued in the last 7 days, which is right for
 * demand-driven triggers and wrong for someone deliberately asking.
 *
 * Backdated rather than deleted: the row also carries the failure counter and the last error,
 * which are worth keeping. Two hours clears both the cooldown and the exponential backoff.
 */
export async function clearCatalogCooldown(artistId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { error } = await client
    .from('release_catalog_state')
    .update({ last_catalogued_at: null, last_attempted_at: twoHoursAgo, consecutive_failures: 0 })
    .eq('artist_id', artistId);

  if (error) console.error('[DB] clearCatalogCooldown failed:', error.message);
}

/**
 * Mark every one of an artist's sources as never priced, so a deliberately-requested crawl
 * re-reads the release pages instead of only the grid.
 *
 * **Clearing the artist's cooldown alone is not enough**, and the gap is invisible: the crawl
 * runs, reports success, and changes nothing an artist can see. Dates, formats and prices live
 * only on individual release pages, and both detail passes skip a source that was already read —
 * Bandcamp's within `DETAIL_REFRESH_DAYS`, Discogs' ever. That refresh rule is right for the
 * demand-driven crawl it was written for, where re-reading every page weekly would triple the
 * request count for data that rarely moves. It is wrong for someone standing in front of the
 * button having just been told their prices are wrong: found once, in exactly that situation,
 * when a parser fix for a bad Bandcamp price shipped and re-cataloguing didn't apply it.
 *
 * Null, not backdated: "never read" is the honest state for a source whose stored price we've
 * decided not to trust, and it's what both passes already test for.
 */
export async function clearReleaseDetailCooldown(artistId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const { data, error: readError } = await client.from('releases').select('id').eq('artist_id', artistId);
  if (readError) {
    console.error('[DB] clearReleaseDetailCooldown read failed:', readError.message);
    return;
  }

  const releaseIds = ((data as { id: string }[] | null) || []).map(r => r.id);
  if (releaseIds.length === 0) return;

  const { error } = await client
    .from('release_sources')
    .update({ detail_checked_at: null })
    .in('release_id', releaseIds);

  if (error) console.error('[DB] clearReleaseDetailCooldown failed:', error.message);
}

interface ReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  source: { platform: string; url: string; externalId: string | null };
}

/**
 * A release row and its source after a write, which is what the detail pass needs to decide
 * whether to spend a request on this release's own page.
 */
export interface PersistedRelease {
  releaseId: string;
  sourceId: string;
  /** The release page for this source — where the date, formats and prices live. */
  url: string;
  /** When that page was last read. Null means never. */
  detailCheckedAt: string | null;
  /** Columns on the release row a verified artist has authored. Ingest leaves these alone. */
  curatedFields: string[];
}

/**
 * Write a catalog run's releases, merging rather than replacing.
 *
 * Three rules that matter more than they look:
 *
 * 1. **Match on `(artist_id, match_key)`, not on slug.** A slug is derived from a title and
 *    changes when the title does; the match key is what identity means here. Release type is
 *    not part of that identity — see `findExactReleaseMatch` for why it can't be, and for the
 *    date check that stands in its place.
 * 2. **Never overwrite a stored value with null.** A partial run — Bandcamp slow, artwork
 *    missing — must not erase a date or artwork a previous run found. This is "never cache
 *    uncertainty" in write form.
 * 3. **Never touch a field an artist has edited.** `curated_fields` lists columns a verified
 *    artist authored; ingest re-runs forever, so without this every crawl silently reverts
 *    their corrections.
 *
 * Returns the releases written or updated, in the order they were given — which for a
 * Bandcamp grid is newest first, so a budgeted detail pass reading the front of the list
 * spends its requests on the releases a fan is most likely to be looking at.
 */
/**
 * Which `(release_id, platform)` source rows an artist has claimed — added or corrected
 * themselves via the curation UI, rather than ingest. Every ingest path must read this before
 * writing a source row: a re-crawl silently overwriting an artist's fix in 30 days would be the
 * exact "ingest clobbers a curated edit" bug `curated_fields` exists to prevent on `releases`
 * itself, just one table over.
 */
export interface ExistingReleaseSource {
  id: string;
  release_id: string;
  platform: string;
  url: string;
  external_id: string | null;
  source: string | null;
  detail_checked_at: string | null;
}

/**
 * Keyed `${releaseId}:${platform}:${externalId ?? ''}` — the table's own uniqueness rule since
 * `20260829120000_release-sources-multi-per-platform.sql`. The empty-string tail is what a row
 * with no external id keys under, and there can be at most one of those per platform.
 */
export type ExistingSourceMap = Map<string, ExistingReleaseSource>;

/** The one place that key is spelled, so a reader and a writer can't drift apart. */
export function releaseSourceKey(releaseId: string, platform: string, externalId: string | null): string {
  return `${releaseId}:${platform}:${externalId ?? ''}`;
}

/**
 * Every `release_sources` row these releases already have.
 *
 * This used to read only the *claimed* keys, as a Set, so `upsertReleaseSource` knew what not to
 * overwrite. It now reads the whole row for every source, which lets that function answer two more
 * questions without a round trip: what a claimed row already says (previously a per-release read),
 * and whether an unclaimed row would actually change (previously an unconditional write).
 *
 * Same one query either way — just more columns.
 */
async function getExistingSources(client: SupabaseClient, releaseIds: string[]): Promise<ExistingSourceMap> {
  const map: ExistingSourceMap = new Map();
  if (releaseIds.length === 0) return map;

  const { data, error } = await client
    .from('release_sources')
    .select('id, release_id, platform, url, external_id, source, detail_checked_at')
    .in('release_id', releaseIds);

  if (error) {
    // An empty map means "assume nothing exists", so every source is written as before. Failing
    // towards writing is right: the alternative is skipping a real update because a read blipped.
    console.error('[DB] getExistingSources failed:', error.message);
    return map;
  }

  for (const row of (data as ExistingReleaseSource[]) || []) {
    map.set(releaseSourceKey(row.release_id, row.platform, row.external_id), row);
  }
  return map;
}

/**
 * Write one release's source row — or don't, when writing it would change nothing.
 *
 * The one place every ingest path goes through to write `release_sources`, so the two rules below
 * only have to be correct once:
 *
 * 1. **Never overwrite a claimed source.** `source: 'claimed'` means an artist added or corrected
 *    this URL themselves; a re-crawl silently replacing it in 30 days is the same bug
 *    `curated_fields` prevents on `releases`, one table over. The claimed row is returned as-is.
 * 2. **Never rewrite an unchanged row.** This used to upsert unconditionally on every pass, which
 *    meant every re-catalogue rewrote every source row it already held — new tuple version, index
 *    entries, WAL, dead tuple — to restate a URL that hadn't moved. Platform URLs almost never
 *    move, so almost all of that was waste, and it contributed to the Disk IO Budget alert.
 *
 * **`last_seen_at` is the casualty of rule 2 and is worth knowing about.** It used to be stamped on
 * every pass, so it meant "when we last confirmed this source exists"; it now only advances when
 * something else about the row changes, so it effectively means "when this row was last written".
 * Nothing reads the column — it has no consumer anywhere in the codebase — which is what makes the
 * trade acceptable. If a real "last confirmed" signal is ever needed, it wants its own cheap
 * mechanism (a periodic batched touch), not a rewrite of every row on every crawl.
 *
 * `detail_checked_at` is read back rather than written, in every branch: it belongs to the detail
 * pass, and a grid re-crawl must not reset it or every crawl would re-fetch every release page.
 */
async function upsertReleaseSource(
  client: SupabaseClient,
  releaseId: string,
  platform: string,
  url: string,
  externalId: string | null,
  existingSources: ExistingSourceMap
): Promise<{ id: string; url: string; detail_checked_at: string | null } | null> {
  // Exact match on the platform's own id first. Failing that, a row for this platform that has
  // no id yet is the same source before we learned what to call it — an early Bandcamp crawl
  // that stored a URL and nothing else, say — so it gets upgraded in place rather than joined
  // by a second row. Only a genuinely new id inserts.
  const prior =
    existingSources.get(releaseSourceKey(releaseId, platform, externalId)) ??
    (externalId ? existingSources.get(releaseSourceKey(releaseId, platform, null)) : undefined);

  if (prior?.source === 'claimed') {
    return { id: prior.id, url: prior.url, detail_checked_at: prior.detail_checked_at };
  }

  if (prior && prior.url === url && prior.external_id === externalId) {
    return { id: prior.id, url: prior.url, detail_checked_at: prior.detail_checked_at };
  }

  // Written as an explicit update-or-insert rather than an upsert: PostgREST infers the conflict
  // target from a plain column list, and this table's uniqueness now lives in an expression
  // index (COALESCE(external_id, '')) that no column list can name.
  const row = {
    release_id: releaseId,
    platform,
    url,
    external_id: externalId,
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = prior
    ? await client.from('release_sources').update(row).eq('id', prior.id).select('id, url, external_id, source, detail_checked_at').single()
    : await client.from('release_sources').insert(row).select('id, url, external_id, source, detail_checked_at').single();

  if (error || !data) return null;

  // Keep the map honest for the rest of this pass, so a second release resolving to the same
  // source doesn't insert over the top of a row this call just wrote.
  const written = data as ExistingReleaseSource;
  existingSources.delete(releaseSourceKey(releaseId, platform, prior?.external_id ?? externalId));
  existingSources.set(releaseSourceKey(releaseId, platform, externalId), {
    ...written,
    release_id: releaseId,
    platform,
  });

  return { id: written.id, url: written.url, detail_checked_at: written.detail_checked_at };
}

export async function persistReleases(
  artistId: string,
  releases: ReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      // `title` is read so the patch below can compare instead of assigning unconditionally.
      .select('id, slug, title, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      title: string | null;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      // Title identity, not `(release_type, match_key)` identity — see findExactReleaseMatch.
      const prior = findExactReleaseMatch(existing, release);
      const curated = new Set(prior?.curated_fields ?? []);

      let releaseId: string;

      if (prior) {
        const patch: Record<string, unknown> = {};
        // COALESCE semantics, applied in JS: only fill what's missing, never blank what's set,
        // and never touch what the artist edited.
        //
        // `!== prior.title` matters more than it looks: this used to assign the title
        // unconditionally, which meant every re-catalogue rewrote every release row it already
        // held — six indexes each — even when the title was byte-identical, which it almost always
        // is. With the comparison, an unchanged release now falls through to an empty patch and
        // does no write at all. See PERSIST_REFRESH_FLOOR_MS for the same problem on `artists`.
        if (!curated.has('title') && release.title !== prior.title) patch.title = release.title;
        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Slug must not collide with anything already stored for this artist.
        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        // Visible to the rest of this batch, so two titles that normalize alike don't both insert.
        existing.push({
          id: releaseId,
          slug,
          title: release.title,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        });
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        release.source.platform,
        release.source.url,
        release.source.externalId,
        existingSources
      );

      if (!source) {
        console.error('[DB] persistReleases source write failed for release', releaseId);
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields: [...curated],
      });
    }

    return written;
  } catch (error) {
    console.error('[DB] persistReleases error:', error);
    return [];
  }
}

interface DetailToPersist {
  releaseDate: string | null;
  datePrecision: string;
  /**
   * Null when this source has nothing to say about the release row itself — Faircamp publishes
   * prices but no date anywhere in its markup, so it can't derive a status either. Writing its
   * default 'released' would overwrite an 'announced' that Bandcamp got right from a real
   * pre-order, so the row is left alone entirely and only the offers are written.
   */
  status: string | null;
  offers: Array<{
    format: string;
    price: number | null;
    currency: string | null;
    availability: string;
  }>;
}

interface ReleaseDetailColumns {
  status: string | null;
  release_date: string | null;
  date_precision: string | null;
}

interface StoredOffer {
  format: string;
  price: number | string | null;
  currency: string | null;
  availability: string;
}

/** Would writing this detail's status/date change the release row at all? */
function releaseRowMatchesDetail(prior: ReleaseDetailColumns | null, detail: DetailToPersist): boolean {
  if (!prior) return false;
  if (prior.status !== detail.status) return false;
  if (!detail.releaseDate) return true;
  // A `date` column reads back as YYYY-MM-DD whatever ISO shape was written into it, so
  // compare on that prefix — a raw string compare against a full timestamp would never match
  // and would quietly turn this skip into a no-op.
  const priorDate = prior.release_date ? String(prior.release_date).slice(0, 10) : null;
  return priorDate === detail.releaseDate.slice(0, 10) && prior.date_precision === detail.datePrecision;
}

/** Same offers, field for field? Order-independent; formats are unique per source. */
function offersMatch(prior: StoredOffer[], offers: DetailToPersist['offers']): boolean {
  if (prior.length !== offers.length) return false;
  const byFormat = new Map(prior.map(o => [o.format, o]));
  return offers.every(offer => {
    const stored = byFormat.get(offer.format);
    if (!stored) return false;
    // `price` is numeric in Postgres; normalize so a string-serialized number still matches.
    const storedPrice = stored.price == null ? null : Number(stored.price);
    return (
      storedPrice === (offer.price ?? null) &&
      (stored.currency ?? null) === (offer.currency ?? null) &&
      stored.availability === offer.availability
    );
  });
}

/**
 * Write what a release's own page told us: its date, and what you can buy there.
 *
 * The order of operations is the interesting part. Offers are written **before** stale ones
 * are pruned, and `detail_checked_at` is stamped **last**:
 *
 * - Writing before pruning means a failure part-way through leaves the old offers in place
 *   rather than an empty offer list. This project has already destroyed an artist's links
 *   once with a delete-before-a-fallible-write (PR #350); an empty release page is the same
 *   shape of mistake.
 * - Pruning only happens when the page actually offered something. Zero offers is the normal
 *   state of a standalone track page, so treating it as "everything was withdrawn" would
 *   erase real prices.
 * - Stamping last means an interrupted run is retried next cycle instead of being recorded as
 *   done.
 *
 * Both writes are read-compare-skip, for the same reason as persistReleases' title comparison:
 * in steady state a 30-day re-check re-derives exactly what the rows already say, and writing
 * it anyway costs a new tuple plus every index to restate nothing — at ~hundreds of detail
 * refreshes a day, that was the largest remaining write source after the first Disk IO audit.
 * A failed pre-read falls through to writing (same rule as getExistingSources): skipping a real
 * update because a read blipped is the worse trade.
 *
 * The casualty is `release_offers.captured_at`, which now advances only when an offer actually
 * changes — it means "when this price last moved", not "when we last confirmed it". The
 * "prices checked" freshness shown to users comes from `release_sources.detail_checked_at`,
 * which IS stamped on every pass (release-detail.ts and release-page.ts both read it).
 *
 * Returns false when nothing could be written, so the caller can count it as a failure.
 */
export async function persistReleaseDetail(
  release: PersistedRelease,
  detail: DetailToPersist
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    // A date the artist authored outranks anything upstream says, and status is derived from
    // the date, so a curated date takes both columns out of ingest's hands.
    if (detail.status !== null && !release.curatedFields.includes('release_date')) {
      const patch: Record<string, unknown> = { status: detail.status };
      if (detail.releaseDate) {
        patch.release_date = detail.releaseDate;
        patch.date_precision = detail.datePrecision;
      }

      const { data: prior } = await client
        .from('releases')
        .select('status, release_date, date_precision')
        .eq('id', release.releaseId)
        .maybeSingle();

      if (!releaseRowMatchesDetail(prior as ReleaseDetailColumns | null, detail)) {
        const { error } = await client.from('releases').update(patch).eq('id', release.releaseId);
        if (error) {
          console.error('[DB] persistReleaseDetail release update failed:', error.message);
          return false;
        }
      }
    }

    if (detail.offers.length > 0) {
      const { data: priorOffers, error: priorOffersError } = await client
        .from('release_offers')
        .select('format, price, currency, availability')
        .eq('release_source_id', release.sourceId);

      const unchanged =
        !priorOffersError && offersMatch((priorOffers as StoredOffer[]) ?? [], detail.offers);

      if (!unchanged) {
        const capturedAt = new Date().toISOString();
        const { error: offerError } = await client.from('release_offers').upsert(
          detail.offers.map(offer => ({
            release_source_id: release.sourceId,
            format: offer.format,
            price: offer.price,
            currency: offer.currency,
            availability: offer.availability,
            captured_at: capturedAt,
          })),
          { onConflict: 'release_source_id,format' }
        );

        if (offerError) {
          console.error('[DB] persistReleaseDetail offer upsert failed:', offerError.message);
          return false;
        }

        const { error: pruneError } = await client
          .from('release_offers')
          .delete()
          .eq('release_source_id', release.sourceId)
          .not('format', 'in', `(${detail.offers.map(o => o.format).join(',')})`);

        // A failed prune leaves a stale format listed, which is worth logging but not worth
        // failing the whole detail write over — the prices we did just refresh are still good.
        if (pruneError) {
          console.error('[DB] persistReleaseDetail offer prune failed:', pruneError.message);
        }
      }
    }

    const { error: stampError } = await client
      .from('release_sources')
      .update({ detail_checked_at: new Date().toISOString() })
      .eq('id', release.sourceId);

    if (stampError) {
      console.error('[DB] persistReleaseDetail stamp failed:', stampError.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DB] persistReleaseDetail error:', error);
    return false;
  }
}

/** What the catalog passes need before they can start. */
export interface ArtistForCatalog {
  name: string;
  bandcampUrl: string | null;
  discogsUrl: string | null;
  faircampUrl: string | null;
  jamcoopUrl: string | null;
  mirloUrl: string | null;
  officialSiteUrl: string | null;
}

/**
 * One read for everything cataloging needs to know about an artist: the display name
 * (Discogs and MusicBrainz are both looked up by name, not by a stored id) plus whichever of
 * the known links are on file. Returns null only when the artist row itself is missing — a
 * source link being absent is a normal, independent per-source outcome, not a reason to fail
 * the whole lookup.
 */
export async function getArtistForCatalog(artistId: string): Promise<ArtistForCatalog | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const [{ data: artistRow, error: artistError }, { data: linkRows, error: linkError }] = await Promise.all([
      client.from('artists').select('name').eq('id', artistId).maybeSingle(),
      client
        .from('artist_links')
        .select('platform, url')
        .eq('artist_id', artistId)
        .in('platform', ['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'mirlo', 'officialsite']),
    ]);

    if (artistError || !artistRow) {
      if (artistError) console.error('[DB] getArtistForCatalog artist read failed:', artistError.message);
      return null;
    }
    if (linkError) console.error('[DB] getArtistForCatalog link read failed:', linkError.message);

    // A placeholder search link is dropped here rather than handed to the crawler, so an artist
    // whose only Bandcamp row is one falls through to catalogArtist's "nothing stored" branch
    // instead of failing on a 404 forever. `officialsite` is not catalogue-able on its own and
    // is filtered by platform above, so it needs no URL-shape check.
    const links = ((linkRows as { platform: string; url: string }[] | null) || []).filter(l =>
      isCatalogueableLink(l.platform, l.url)
    );
    return {
      name: (artistRow as { name: string }).name,
      bandcampUrl: links.find(l => l.platform === 'bandcamp')?.url ?? null,
      discogsUrl: links.find(l => l.platform === 'discogs')?.url ?? null,
      faircampUrl: links.find(l => l.platform === 'faircamp')?.url ?? null,
      jamcoopUrl: links.find(l => l.platform === 'jamcoop')?.url ?? null,
      mirloUrl: links.find(l => l.platform === 'mirlo')?.url ?? null,
      officialSiteUrl: links.find(l => l.platform === 'officialsite')?.url ?? null,
    };
  } catch (error) {
    console.error('[DB] getArtistForCatalog error:', error);
    return null;
  }
}

interface DiscogsReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  masterId: string;
  mainReleaseId: string;
}

/**
 * Write a Discogs catalog pass, merging into whatever's already there rather than replacing
 * it — same shape and same three rules as `persistReleases`, plus a fourth this source needs
 * and Bandcamp didn't, because Bandcamp is the only source in the catalog:
 *
 * 4. **Prefer the hard identifier over the title guess.** `discogs_master_id` is Discogs'
 *    own "these pressings are one album" conclusion — tier 1 in the dedup scheme (spec §4).
 *    Only fall back to the title match — tier 2, `findExactReleaseMatch` — when this artist
 *    has no row with that master id yet, and only when that tier-2 candidate doesn't already
 *    carry a *different* master id (which would mean the title match is coincidental, not the
 *    same release). And when nothing matches exactly but a title is merely *close* to an
 *    existing one, this never merges either: it inserts a new row and flags both
 *    `needs_review`, which is tier 3. A human decides; the catalog never silently asserts two
 *    different albums are the same one.
 *
 *    A master id is looked up in `release_sources` as well as in `releases.discogs_master_id`,
 *    because the release column holds only one and an admin merge of two masters leaves the
 *    second on the source row. Skipping that read is what would let a merged pair come back.
 */
export async function persistDiscogsReleases(
  artistId: string,
  releases: DiscogsReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      // `title` is read so the patch below can compare instead of assigning unconditionally.
      .select('id, slug, title, match_key, release_type, release_date, date_precision, curated_fields, discogs_master_id')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistDiscogsReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      title: string | null;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      curated_fields: string[] | null;
      discogs_master_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMasterId = new Map(
      existing.filter(r => r.discogs_master_id).map(r => [r.discogs_master_id as string, r])
    );
    const byType = new Map<string, ExistingRow[]>();
    for (const row of existing) {
      const bucket = byType.get(row.release_type);
      if (bucket) bucket.push(row);
      else byType.set(row.release_type, [row]);
    }
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    // A release that an admin merged with a second Discogs master carries that master's id on
    // its *source* row: `releases.discogs_master_id` holds exactly one, and the merge keeps the
    // survivor's. Reading both is what makes such a merge durable — without it, the very next
    // catalogue pass wouldn't recognise the second master and would re-create the row the human
    // just merged away, which is how a review queue refills itself forever.
    //
    // Kept in its own map rather than folded into `byMasterId`, because these two answer
    // different questions. `byMasterId` means "this row *is* that master", which is what
    // licenses overwriting the stored title from Discogs. A merged-away master means "this row
    // absorbed that master" — the title on the survivor is the one a human chose to keep, and
    // the other master's title must not replace it.
    const byReleaseId = new Map(existing.map(r => [r.id, r]));
    const byMergedMasterId = new Map<string, ExistingRow>();
    for (const source of existingSources.values()) {
      if (source.platform !== 'discogs' || !source.external_id) continue;
      if (byMasterId.has(source.external_id)) continue;
      const row = byReleaseId.get(source.release_id);
      if (row) byMergedMasterId.set(source.external_id, row);
    }

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      let prior = byMasterId.get(release.masterId);
      const matchedByMasterId = Boolean(prior);
      if (!prior) prior = byMergedMasterId.get(release.masterId);

      if (!prior) {
        const exact = findExactReleaseMatch(existing, release);
        // A tier-2 title match that already carries a *different* master id is Discogs itself
        // saying these are two records, which outranks our title guess.
        if (exact && (!exact.discogs_master_id || exact.discogs_master_id === release.masterId)) {
          prior = exact;
        }
      }

      // Tier 3: nothing exact, but something close enough to warrant a human look. Never
      // merge — insert a new row below and flag both sides, with each pointing at the other
      // via `flagged_against_release_id` so an admin queue can show the pair without having
      // to re-run the fuzzy match to reconstruct what triggered it.
      const fuzzy = prior
        ? null
        : findFuzzyReleaseMatch(byType.get(release.releaseType) ?? [], release);

      let releaseId: string;
      let curatedFields: string[];

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        // Title is only ever taken from a hard-identifier match (a re-crawl of a release we
        // already know is this one). A tier-2 title-equality match means the two titles
        // already normalize the same — overwriting risks nothing informative and risks
        // clobbering a display-quality title Bandcamp already got right.
        // Compared rather than assigned, for the same reason as persistReleases above: a re-crawl
        // that finds the identical title should write nothing.
        if (!curated.has('title') && matchedByMasterId && release.title !== prior.title) {
          patch.title = release.title;
        }
        if (!prior.discogs_master_id) patch.discogs_master_id = release.masterId;
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistDiscogsReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            discogs_master_id: release.masterId,
            source: 'auto',
            // fuzzy.id is already known here, unlike the reverse direction below — this row
            // can point at its suspected duplicate in the same write that creates it.
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistDiscogsReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        const createdRow: ExistingRow = {
          id: releaseId,
          slug,
          title: release.title,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          curated_fields: [],
          discogs_master_id: release.masterId,
        };
        byMasterId.set(release.masterId, createdRow);
        existing.push(createdRow);
        const bucket = byType.get(release.releaseType);
        if (bucket) bucket.push(createdRow);
        else byType.set(release.releaseType, [createdRow]);

        // The reverse direction: fuzzy's own id wasn't known until the new row above existed,
        // so this side is written second. Never merge — flagging both sides is the whole
        // point of tier 3.
        if (fuzzy) {
          const { error: flagError } = await client
            .from('releases')
            .update({ needs_review: true, flagged_against_release_id: releaseId })
            .eq('id', fuzzy.id);
          if (flagError) console.error('[DB] persistDiscogsReleases fuzzy-flag failed:', flagError.message);
        }
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'discogs',
        // The specific pressing Discogs treats as this master's representative release — a
        // real listing page, unlike the abstract master page.
        `https://www.discogs.com/release/${release.mainReleaseId}`,
        release.masterId,
        existingSources
      );

      if (!source) {
        console.error('[DB] persistDiscogsReleases source write failed for release', releaseId);
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    return written;
  } catch (error) {
    console.error('[DB] persistDiscogsReleases error:', error);
    return [];
  }
}

interface MusicBrainzEnrichmentInput {
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  mbid: string;
}

/**
 * Fill in what MusicBrainz knows about releases we already have: a date at whatever precision
 * MusicBrainz actually carries, and the release-group MBID as a hard identity anchor for
 * future dedup passes (including Discogs and Bandcamp re-crawls, once one of them also finds
 * this MBID some other way).
 *
 * **Update-only, by design.** MusicBrainz has no purchase link to offer, so unlike Bandcamp
 * and Discogs this never inserts a new release row — a release page with a date and nowhere
 * to buy it would be a worse outcome than not having the page at all.
 *
 * Matches tier 1 (an existing `musicbrainz_release_group_id`) first, then tier 2
 * (`findExactReleaseMatch`) — and only when that tier-2 candidate doesn't already carry a
 * *different* MBID, which would mean the title match is coincidental. Returns how many rows
 * were touched.
 */
export async function persistMusicBrainzEnrichment(
  artistId: string,
  groups: MusicBrainzEnrichmentInput[]
): Promise<number> {
  const client = getClient();
  if (!client || groups.length === 0) return 0;

  try {
    const { data: existingRows, error } = await client
      .from('releases')
      .select('id, match_key, release_type, release_date, date_precision, curated_fields, musicbrainz_release_group_id')
      .eq('artist_id', artistId);

    if (error) {
      console.error('[DB] persistMusicBrainzEnrichment read failed:', error.message);
      return 0;
    }

    type ExistingRow = {
      id: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      curated_fields: string[] | null;
      musicbrainz_release_group_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMbid = new Map(
      existing.filter(r => r.musicbrainz_release_group_id).map(r => [r.musicbrainz_release_group_id as string, r])
    );

    let touched = 0;

    for (const group of groups) {
      let row = byMbid.get(group.mbid);
      if (!row) {
        const candidate = findExactReleaseMatch(existing, group);
        if (candidate && (!candidate.musicbrainz_release_group_id || candidate.musicbrainz_release_group_id === group.mbid)) {
          row = candidate;
        }
      }
      // MusicBrainz alone never creates a row — if nothing here matches, there's nothing yet
      // to attach this enrichment to.
      if (!row) continue;

      const curated = new Set(row.curated_fields ?? []);
      const patch: Record<string, unknown> = {};
      if (!row.musicbrainz_release_group_id) patch.musicbrainz_release_group_id = group.mbid;
      if (!curated.has('release_date') && group.releaseDate && !row.release_date) {
        patch.release_date = group.releaseDate;
        patch.date_precision = group.datePrecision;
      }
      if (Object.keys(patch).length === 0) continue;

      const { error: updateError } = await client.from('releases').update(patch).eq('id', row.id);
      if (updateError) {
        console.error('[DB] persistMusicBrainzEnrichment update failed:', updateError.message);
        continue;
      }
      touched++;
    }

    return touched;
  } catch (error) {
    console.error('[DB] persistMusicBrainzEnrichment error:', error);
    return 0;
  }
}

/**
 * Write a Faircamp catalog pass.
 *
 * Matches on `match_key` via `findExactReleaseMatch`, which ignores release type. Faircamp's
 * own type guess (`mapDiscogsFormatToReleaseType` reading just a title) is unreliable enough
 * that partitioning by it would systematically block the one thing that makes Faircamp worth
 * ingesting: merging into a release Bandcamp or Discogs already typed correctly, adding
 * Faircamp as a second source on the *same* row instead of a duplicate. That argument turned
 * out to hold for every source, which is why it is now the rule everywhere rather than this
 * function's exception. When nothing matches exactly, a title merely *close* to an existing
 * one still only ever flags (tier 3) — never merges — same as Discogs.
 *
 * Faircamp publishes no release date, so the date check inside both matchers is inert here:
 * with nothing to compare, there is no evidence of difference and the title stands alone.
 *
 * Release type is never overwritten on an existing row; whichever source typed it first stands.
 */
interface FaircampReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistFaircampReleases(
  artistId: string,
  releases: FaircampReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistFaircampReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const prior = findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistFaircampReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistFaircampReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        const createdRow: ExistingRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);

        if (fuzzy) {
          const { error: flagError } = await client
            .from('releases')
            .update({ needs_review: true, flagged_against_release_id: releaseId })
            .eq('id', fuzzy.id);
          if (flagError) console.error('[DB] persistFaircampReleases fuzzy-flag failed:', flagError.message);
        }
      }

      const source = await upsertReleaseSource(client, releaseId, 'faircamp', release.externalUrl, release.externalUrl, existingSources);
      if (!source) {
        console.error('[DB] persistFaircampReleases source write failed for release', releaseId);
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    return written;
  } catch (error) {
    console.error('[DB] persistFaircampReleases error:', error);
    return [];
  }
}

/**
 * Write a Jam.coop catalog pass.
 *
 * Matches on `match_key` alone for the same reason `persistFaircampReleases` does: Jam.coop
 * files every release under `/albums/` and exposes no type field, so its inferred release type
 * is too weak to partition identity by, and partitioning by it would produce a duplicate row
 * every time Bandcamp had already typed the same record correctly.
 *
 * Where it differs from Faircamp is the date. Jam.coop publishes one on the album page, so this
 * fills `release_date`/`date_precision` on an existing row that lacks them — under the same
 * never-overwrite rules as everywhere else: a stored date wins over a new one, and a date the
 * artist curated is never touched at all.
 */
interface JamcoopReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistJamcoopReleases(
  artistId: string,
  releases: JamcoopReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistJamcoopReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const prior = findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
          // Status is derived from the date, so the two move together — but only when this pass
          // is the one supplying the date. An existing dated row keeps whatever status its own
          // source derived, including an 'announced' from a real pre-order flag.
          patch.status = release.status;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistJamcoopReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistJamcoopReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        const createdRow: ExistingRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);

        if (fuzzy) {
          const { error: flagError } = await client
            .from('releases')
            .update({ needs_review: true, flagged_against_release_id: releaseId })
            .eq('id', fuzzy.id);
          if (flagError) console.error('[DB] persistJamcoopReleases fuzzy-flag failed:', flagError.message);
        }
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'jamcoop',
        release.externalUrl,
        release.externalUrl,
        existingSources
      );
      if (!source) {
        console.error('[DB] persistJamcoopReleases source write failed for release', releaseId);
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    return written;
  } catch (error) {
    console.error('[DB] persistJamcoopReleases error:', error);
    return [];
  }
}

/**
 * Write a Mirlo catalog pass.
 *
 * Matches on `match_key` alone, for the same reason `persistJamcoopReleases` does: Mirlo
 * populates `type` on only a small minority of releases (5 of 209 measured live), so the stored
 * type is usually title-inferred and too weak to partition identity by. Partitioning on it would
 * mint a duplicate row every time Bandcamp had already typed the same record correctly.
 *
 * Dedup behaviour is the same as every other source: `findExactReleaseMatch` merges into the
 * existing row, `findFuzzyReleaseMatch` flags a pair for human review, and nothing new
 * auto-merges. Under-merge is preserved deliberately.
 *
 * Like Jam.coop, Mirlo publishes a date, so this fills `release_date`/`date_precision` on a row
 * that lacks them — under the usual never-overwrite rules: a stored date wins over a new one,
 * and a date the artist curated is never touched.
 */
interface MirloReleaseToPersistRow {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistMirloReleases(
  artistId: string,
  releases: MirloReleaseToPersistRow[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistMirloReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const prior = findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
          // Status moves with the date, but only when this pass is the one supplying it. A row
          // that already had a date keeps whatever status its own source derived — including an
          // 'announced' from a real pre-order flag.
          patch.status = release.status;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistMirloReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistMirloReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        const createdRow: ExistingRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);

        if (fuzzy) {
          const { error: flagError } = await client
            .from('releases')
            .update({ needs_review: true, flagged_against_release_id: releaseId })
            .eq('id', fuzzy.id);
          if (flagError) console.error('[DB] persistMirloReleases fuzzy-flag failed:', flagError.message);
        }
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'mirlo',
        release.externalUrl,
        release.externalUrl,
        existingSources
      );
      if (!source) {
        console.error('[DB] persistMirloReleases source write failed for release', releaseId);
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    return written;
  } catch (error) {
    console.error('[DB] persistMirloReleases error:', error);
    return [];
  }
}

/**
 * Attach a source *discovered* on some other page (never fetched directly — see
 * `findDiscoveredReleaseLinks`) to an existing release, matched by **exact** normalized title.
 * Exact only, deliberately: a wrong attachment here would point a fan at a different record
 * than the one they're looking at, which is worse than never finding the link at all. Refuses
 * rather than guesses when the match key is ambiguous (two releases share it) or the release
 * already has a source for this platform.
 */
export async function attachDiscoveredSource(
  artistId: string,
  platform: string,
  url: string,
  matchKey: string
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data, error } = await client
      .from('releases')
      .select('id, release_sources ( platform )')
      .eq('artist_id', artistId)
      .eq('match_key', matchKey);

    if (error) {
      console.error('[DB] attachDiscoveredSource read failed:', error.message);
      return false;
    }

    const matches = (data as { id: string; release_sources: { platform: string }[] | null }[]) || [];
    if (matches.length !== 1) return false; // no match, or ambiguous — never guess

    const release = matches[0];
    if ((release.release_sources || []).some(s => s.platform === platform)) return false;

    const { error: insertError } = await client.from('release_sources').insert({
      release_id: release.id,
      platform,
      url,
      external_id: null,
      source: 'auto',
    });

    if (insertError) {
      console.error('[DB] attachDiscoveredSource insert failed:', insertError.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] attachDiscoveredSource error:', error);
    return false;
  }
}

// --- Tier-3 dedup admin review queue ---
//
// The backstop the dedup scheme (spec §4) leans on once claiming is optional: ingest never
// auto-merges a fuzzy match, it only flags both sides via `needs_review` and
// `flagged_against_release_id`. These functions are the read side (list flagged pairs) and the
// two things an admin can do about one: say they're different (dismiss) or say they're the
// same (merge).

export interface ReleaseReviewItem {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  artistName: string;
  artistSlug: string;
  platforms: string[];
}

/**
 * Fold a flat needs_review result set into pairs, deduplicating the two rows a symmetric flag
 * always produces (A flagged against B, and B flagged against A, are one pair to review, not
 * two). Pure and exported for tests — no network, no database.
 *
 * A row whose counterpart isn't in the set (already resolved from the other side, or deleted)
 * is still shown, alone, rather than dropped — something about it looked ambiguous enough to
 * flag, and silently hiding that is worse than showing it with nothing to compare against.
 */
export function pairReviewRows(
  rows: Map<string, ReleaseReviewItem & { flaggedAgainst: string | null }>
): { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[] {
  const seen = new Set<string>();
  const pairs: { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[] = [];

  for (const row of rows.values()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const counterpart = row.flaggedAgainst ? rows.get(row.flaggedAgainst) ?? null : null;
    if (counterpart) seen.add(counterpart.id);

    pairs.push({ primary: row, counterpart });
  }

  return pairs;
}

/**
 * Every release currently flagged for review, paired with its suspected duplicate where one is
 * still on file. Hidden releases are excluded — an admin has already ruled on those.
 */
export async function getReleaseReviewQueue(): Promise<
  { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[]
> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('releases')
      .select(
        'id, title, slug, release_type, release_date, date_precision, artwork_url, flagged_against_release_id,' +
        ' artists ( name, slug ), release_sources ( platform )'
      )
      .eq('needs_review', true)
      .eq('is_hidden', false)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[DB] getReleaseReviewQueue failed:', error.message);
      return [];
    }

    type Row = {
      id: string;
      title: string;
      slug: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      flagged_against_release_id: string | null;
      artists: { name: string; slug: string } | { name: string; slug: string }[] | null;
      release_sources: { platform: string }[] | null;
    };

    const rows = new Map<string, ReleaseReviewItem & { flaggedAgainst: string | null }>();

    for (const r of (data as unknown as Row[]) || []) {
      const artist = Array.isArray(r.artists) ? r.artists[0] : r.artists;
      rows.set(r.id, {
        id: r.id,
        title: r.title,
        slug: r.slug,
        releaseType: r.release_type,
        releaseDate: r.release_date,
        datePrecision: r.date_precision,
        artworkUrl: r.artwork_url,
        artistName: artist?.name ?? '(unknown)',
        artistSlug: artist?.slug ?? '',
        platforms: [...new Set((r.release_sources || []).map(s => s.platform))],
        flaggedAgainst: r.flagged_against_release_id,
      });
    }

    return pairReviewRows(rows);
  } catch (error) {
    console.error('[DB] getReleaseReviewQueue error:', error);
    return [];
  }
}

/**
 * "These are different releases." Clears the flag on both sides of the pair — including the
 * counterpart, looked up here rather than trusted from the client, since flagged_against_
 * release_id is what makes them a pair and both must stop pointing at the resolved question.
 */
export async function dismissReleaseReview(releaseId: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data: row, error: readError } = await client
      .from('releases')
      .select('id, flagged_against_release_id')
      .eq('id', releaseId)
      .maybeSingle();

    if (readError || !row) {
      console.error('[DB] dismissReleaseReview read failed:', readError?.message ?? 'not found');
      return false;
    }

    const counterpartId = (row as { flagged_against_release_id: string | null }).flagged_against_release_id;
    const ids = counterpartId ? [releaseId, counterpartId] : [releaseId];

    const { error } = await client
      .from('releases')
      .update({ needs_review: false, flagged_against_release_id: null })
      .in('id', ids);

    if (error) {
      console.error('[DB] dismissReleaseReview update failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] dismissReleaseReview error:', error);
    return false;
  }
}

export interface MergeReleasesResult {
  ok: boolean;
  error?: string;
}

/**
 * "These are the same release." Moves every source off `dropId` onto `keepId`, fills in
 * whatever `keepId` is missing (date, artwork) without overwriting anything it already has or
 * anything an artist curated, then deletes the now-empty `dropId` row.
 *
 * Sources are moved **before** the duplicate row is deleted, and the delete is only attempted
 * once that move has succeeded — this project has already lost data once to a delete-before-a-
 * fallible-write (PR #350, an artist's links wiped by a preview), and a release merge is the
 * same shape of risk.
 *
 * Two sources on the same platform are carried over rather than refused, as long as the
 * platform's own ids tell them apart. That is the ordinary shape of the thing this queue is
 * mostly full of: Discogs holding two masters for one record, both of them real listings worth
 * keeping. What still stops the merge is a pair that *can't* be told apart — a source on a
 * shared platform with no external id on one side or the other — because the surviving row
 * could then hold two indistinguishable entries for one platform, and nothing downstream could
 * ever reconcile them.
 */
export async function mergeReleases(keepId: string, dropId: string): Promise<MergeReleasesResult> {
  const client = getClient();
  if (!client) return { ok: false, error: 'Database not configured' };
  if (keepId === dropId) return { ok: false, error: 'Cannot merge a release into itself' };

  try {
    // Both releases must belong to the same artist. The invariant lives *here*, not only at the
    // call sites, because a merge is close to irreversible — sources are moved and a row is
    // deleted — and the two callers reach it by different routes: the artist endpoint proves
    // ownership of both ids (`verifyReleaseOwnership`), while the admin endpoint passes ids
    // straight from a request body. Today the admin UI only ever submits pairs from the review
    // queue, which is same-artist by construction, but "no caller currently sends a mismatched
    // pair" is not something the database should be relying on.
    const { data: pair, error: pairError } = await client
      .from('releases')
      .select('id, artist_id')
      .in('id', [keepId, dropId]);

    if (pairError) {
      console.error('[DB] mergeReleases identity read failed:', pairError.message);
      return { ok: false, error: 'Failed to read releases' };
    }

    const rows = (pair as { id: string; artist_id: string }[] | null) || [];
    if (rows.length !== 2) return { ok: false, error: 'One or both releases could not be found' };
    if (rows[0].artist_id !== rows[1].artist_id) {
      // Deliberately not reported back with the artist ids in it — the caller supplied a pair
      // they had no business pairing, and echoing whose release the other one is would confirm
      // the existence of a row they can't otherwise see.
      console.error('[DB] mergeReleases refused a cross-artist merge');
      return { ok: false, error: 'Those releases belong to different artists' };
    }

    const [{ data: keepSources, error: keepError }, { data: dropSources, error: dropError }] = await Promise.all([
      client.from('release_sources').select('platform, external_id').eq('release_id', keepId),
      client.from('release_sources').select('id, platform, external_id').eq('release_id', dropId),
    ]);

    if (keepError || dropError) {
      console.error('[DB] mergeReleases read failed:', keepError?.message, dropError?.message);
      return { ok: false, error: 'Failed to read sources' };
    }

    const keep = (keepSources as { platform: string; external_id: string | null }[] | null) || [];
    const drop = (dropSources as { id: string; platform: string; external_id: string | null }[] | null) || [];

    const keepIdsByPlatform = new Map<string, (string | null)[]>();
    for (const source of keep) {
      const bucket = keepIdsByPlatform.get(source.platform);
      if (bucket) bucket.push(source.external_id);
      else keepIdsByPlatform.set(source.platform, [source.external_id]);
    }

    // Only an *indistinguishable* pair blocks. Two Discogs masters carry two ids and merge
    // fine; a source with no id on either side can't be separated from the one it would sit
    // beside, and `idx_release_sources_release_platform_external` would reject it anyway.
    const conflicting = drop.filter(source => {
      const keepIds = keepIdsByPlatform.get(source.platform);
      if (!keepIds) return false;
      return !source.external_id || keepIds.some(id => !id || id === source.external_id);
    });

    if (conflicting.length > 0) {
      const platforms = [...new Set(conflicting.map(c => c.platform))].join(', ');
      return { ok: false, error: `Both releases have an unidentified source on: ${platforms} — resolve manually` };
    }

    if (drop.length > 0) {
      const { error: moveError } = await client
        .from('release_sources')
        .update({ release_id: keepId })
        .eq('release_id', dropId);

      if (moveError) {
        console.error('[DB] mergeReleases move failed:', moveError.message);
        return { ok: false, error: 'Failed to move sources' };
      }
    }

    const anchors: Record<string, unknown> = {};

    const [{ data: keepRow }, { data: dropRow }] = await Promise.all([
      client.from('releases').select('release_date, artwork_url, curated_fields, discogs_master_id, musicbrainz_release_group_id').eq('id', keepId).maybeSingle(),
      client.from('releases').select('release_date, date_precision, artwork_url, discogs_master_id, musicbrainz_release_group_id').eq('id', dropId).maybeSingle(),
    ]);

    if (keepRow && dropRow) {
      const curated = new Set((keepRow as { curated_fields: string[] | null }).curated_fields ?? []);
      const patch: Record<string, unknown> = {};
      const keepFields = keepRow as {
        release_date: string | null;
        artwork_url: string | null;
        discogs_master_id: string | null;
        musicbrainz_release_group_id: string | null;
      };
      const dropFields = dropRow as {
        release_date: string | null;
        date_precision: string | null;
        artwork_url: string | null;
        discogs_master_id: string | null;
        musicbrainz_release_group_id: string | null;
      };

      if (!curated.has('release_date') && dropFields.release_date && !keepFields.release_date) {
        patch.release_date = dropFields.release_date;
        patch.date_precision = dropFields.date_precision;
      }
      if (!curated.has('artwork_url') && dropFields.artwork_url && !keepFields.artwork_url) {
        patch.artwork_url = dropFields.artwork_url;
      }
      if (Object.keys(patch).length > 0) {
        await client.from('releases').update(patch).eq('id', keepId);
      }

      // Identity anchors move across too, or the next catalogue pass finds no row for the
      // dropped master/release group and re-creates exactly what was just merged away. Where
      // the survivor already has one of its own, the dropped id still survives as the
      // `external_id` on the source row moved above, which is where ingest also looks.
      //
      // Written *after* the delete below, not here: both columns are covered by a unique index
      // per artist, so copying an id onto the survivor while the row it came from still holds
      // it is a constraint violation, not a merge.
      if (dropFields.discogs_master_id && !keepFields.discogs_master_id) {
        anchors.discogs_master_id = dropFields.discogs_master_id;
      }
      if (dropFields.musicbrainz_release_group_id && !keepFields.musicbrainz_release_group_id) {
        anchors.musicbrainz_release_group_id = dropFields.musicbrainz_release_group_id;
      }
    }

    // Safe now: every source under dropId has been moved (or there were none), and the
    // conflict check above means nothing was left behind to lose.
    const { error: deleteError } = await client.from('releases').delete().eq('id', dropId);
    if (deleteError) {
      console.error('[DB] mergeReleases delete failed:', deleteError.message);
      return { ok: false, error: 'Sources moved, but failed to remove the duplicate row' };
    }

    const { error: clearError } = await client
      .from('releases')
      .update({ needs_review: false, flagged_against_release_id: null, ...anchors })
      .eq('id', keepId);
    if (clearError) console.error('[DB] mergeReleases clear-flag failed:', clearError.message);

    return { ok: true };
  } catch (error) {
    console.error('[DB] mergeReleases error:', error);
    return { ok: false, error: 'Unexpected error' };
  }
}

// --- Artist release curation (spec §11) ---
//
// The artist-facing half of the dedup backstop, and the durable fix for whatever the ~4%
// wrong-artist probe rate and under-merge bias leave behind: a verified artist reviewing their
// own catalog is the one source of ground truth ingest can never have. Every write here goes
// through the same "service role + server-side ownership check" convention as
// `api/functions/artist-profile.ts` — there is no RLS policy keyed to auth.uid() for these
// tables (see the comment on `releases` in the schema migration), so the ownership check below
// *is* the security boundary, not a UI nicety.

export interface OwnedArtistCheck {
  ok: boolean;
  status: number;
  error?: string;
  artistId?: string;
  artistName?: string;
}

/**
 * Resolve a slug to an artist and verify the given user owns a verified claim on it. The same
 * check `artist-profile.ts` inlines for bio/link edits, factored out here so newer
 * release-curation endpoints don't each carry their own copy of an auth-critical block.
 */
export async function resolveOwnedArtist(slug: string, userId: string): Promise<OwnedArtistCheck> {
  const client = getClient();
  if (!client) return { ok: false, status: 500, error: 'Database not configured' };

  const { data: artist, error: findError } = await client
    .from('artists')
    .select('id, name')
    .eq('slug', slug)
    .single();

  if (findError || !artist) return { ok: false, status: 404, error: 'Artist not found' };

  const { data: profile, error: profileError } = await client
    .from('artist_profiles')
    .select('user_id, verified_at')
    .eq('artist_id', artist.id)
    .single();

  if (profileError || !profile) return { ok: false, status: 404, error: 'Profile not found' };
  if (profile.user_id !== userId) return { ok: false, status: 403, error: 'You do not own this profile' };
  if (!profile.verified_at) return { ok: false, status: 403, error: 'Profile not yet verified' };

  return { ok: true, status: 200, artistId: (artist as { id: string }).id, artistName: (artist as { name: string }).name };
}

/**
 * Do all of these release ids actually belong to this artist? `resolveOwnedArtist` proves the
 * caller owns *an* artist profile — it says nothing about whether the release ids they sent in
 * the request body are that artist's. Every action that takes a release id from the client
 * must check this before touching the row, or a claimed artist could hide/merge/edit another
 * artist's releases by guessing UUIDs.
 */
export async function verifyReleaseOwnership(artistId: string, releaseIds: string[]): Promise<boolean> {
  const client = getClient();
  if (!client || releaseIds.length === 0) return false;

  const unique = [...new Set(releaseIds)];
  const { data, error } = await client
    .from('releases')
    .select('id')
    .eq('artist_id', artistId)
    .in('id', unique);

  if (error) {
    console.error('[DB] verifyReleaseOwnership failed:', error.message);
    return false;
  }
  return (data || []).length === unique.length;
}

export interface OwnerReleaseItem {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  isHidden: boolean;
  needsReview: boolean;
  flaggedAgainst: { id: string; title: string } | null;
  /** Position in the artist's manual order, or null if they haven't arranged this one. */
  displayOrder: number | null;
  sources: { platform: string; url: string }[];
}

/**
 * Every release under this artist — including hidden ones and needs_review ones, unlike the
 * public `getArtistReleases`, because the whole point of this view is letting the artist see
 * what ingest did (right or wrong) rather than only what a fan would see.
 *
 * Ordered exactly as the public page orders them, so what the artist arranges here is what a
 * fan sees rather than a second arrangement that only exists in the editor.
 */
export async function getArtistReleasesForOwner(artistId: string): Promise<OwnerReleaseItem[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('releases')
      .select(
        'id, title, slug, release_type, release_date, date_precision, artwork_url, is_hidden,' +
        ' needs_review, flagged_against_release_id, display_order, release_sources ( platform, url )'
      )
      .eq('artist_id', artistId)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('release_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[DB] getArtistReleasesForOwner failed:', error.message);
      return [];
    }

    type Row = {
      id: string;
      title: string;
      slug: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      is_hidden: boolean;
      needs_review: boolean;
      flagged_against_release_id: string | null;
      display_order: number | null;
      release_sources: { platform: string; url: string }[] | null;
    };

    const rows = (data as unknown as Row[]) || [];
    // The counterpart a release is flagged against is always another row in this same result
    // set — tier-3 fuzzy matching only ever compares releases under one artist — so resolving
    // its title costs nothing extra to fetch.
    const titleById = new Map(rows.map(r => [r.id, r.title]));

    return rows.map(r => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      releaseType: r.release_type,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      artworkUrl: r.artwork_url,
      isHidden: r.is_hidden,
      needsReview: r.needs_review,
      flaggedAgainst:
        r.flagged_against_release_id && titleById.has(r.flagged_against_release_id)
          ? { id: r.flagged_against_release_id, title: titleById.get(r.flagged_against_release_id)! }
          : null,
      displayOrder: r.display_order,
      sources: (r.release_sources || []).map(s => ({ platform: s.platform, url: s.url })),
    }));
  } catch (error) {
    console.error('[DB] getArtistReleasesForOwner error:', error);
    return [];
  }
}

/**
 * Store a claimed artist's manual release order.
 *
 * `releaseIds` is the complete arrangement the editor is showing, in display order. Releases
 * left out of it are reset to unpositioned, so an empty array is "back to newest first", and a
 * release catalogued between the page loading and saving isn't handed a position nobody chose —
 * it stays null and sorts to the end.
 *
 * One RPC because it's one transaction: a half-written order is an arrangement the artist never
 * picked, showing on their public page. Same reasoning as `replace_artist_links`.
 */
export async function setReleaseDisplayOrder(artistId: string, releaseIds: string[]): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  const { error } = await client.rpc('set_release_display_order', {
    p_artist_id: artistId,
    p_release_ids: releaseIds,
  });

  if (error) {
    console.error('[DB] setReleaseDisplayOrder failed:', error.message);
    return false;
  }
  return true;
}

/** "This shouldn't be on my page." Ingest must never write `is_hidden` — only this, or an admin. */
export async function setReleaseHidden(artistId: string, releaseId: string, hidden: boolean): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  const { error } = await client.from('releases').update({ is_hidden: hidden }).eq('id', releaseId);
  if (error) {
    console.error('[DB] setReleaseHidden failed:', error.message);
    return false;
  }
  return true;
}

export interface ReleaseFieldPatch {
  title?: string;
  /** null clears the date entirely; omit the key to leave it untouched. */
  releaseDate?: string | null;
  artworkUrl?: string | null;
}

/**
 * "Fix" — correct a title, date, or artwork ingest got wrong. Every field touched here is
 * added to `curated_fields`, the existing provenance mechanism that stops a later re-crawl from
 * silently reverting the artist's correction (see the `releases` migration's own comment on
 * why this had to ship in step 1, not be retrofitted later).
 */
export async function updateArtistReleaseFields(
  artistId: string,
  releaseId: string,
  patch: ReleaseFieldPatch
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  const { data: row, error: readError } = await client
    .from('releases')
    .select('curated_fields')
    .eq('id', releaseId)
    .maybeSingle();

  if (readError || !row) {
    console.error('[DB] updateArtistReleaseFields read failed:', readError?.message ?? 'not found');
    return false;
  }

  const curated = new Set((row as { curated_fields: string[] | null }).curated_fields ?? []);
  const update: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200);
    if (!title) return false;
    update.title = title;
    curated.add('title');
  }
  if (patch.releaseDate !== undefined) {
    if (patch.releaseDate === null) {
      update.release_date = null;
      update.date_precision = 'unknown';
    } else {
      const { date, precision } = parseReleaseDate(patch.releaseDate);
      if (!date) return false;
      update.release_date = date;
      update.date_precision = precision;
    }
    curated.add('release_date');
  }
  if (patch.artworkUrl !== undefined) {
    update.artwork_url = patch.artworkUrl;
    curated.add('artwork_url');
  }

  if (Object.keys(update).length === 0) return true;
  update.curated_fields = [...curated];

  const { error } = await client.from('releases').update(update).eq('id', releaseId);
  if (error) {
    console.error('[DB] updateArtistReleaseFields update failed:', error.message);
    return false;
  }
  return true;
}

/**
 * "Add a platform link we missed" — or correct one ingest got wrong. Written with
 * `source: 'claimed'`, which `getExistingSources` (used by every ingest path) checks before
 * ever overwriting a source's URL — the same "never clobber a curated edit" rule `curated_fields`
 * enforces on the release row itself, one table over.
 */
export async function addArtistReleaseLink(
  artistId: string,
  releaseId: string,
  platform: string,
  url: string
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  if (!(await verifyReleaseOwnership(artistId, [releaseId]))) return false;

  // `external_id` is never written here, in either branch. It is the one thing that makes a
  // re-crawl idempotent, so an artist correcting a URL must leave whatever id ingest stored
  // exactly as it is — writing an explicit null would have the next crawl mint a duplicate
  // source rather than update this row.
  const { data: existingRows, error: readError } = await client
    .from('release_sources')
    .select('id')
    .eq('release_id', releaseId)
    .eq('platform', platform);

  if (readError) {
    console.error('[DB] addArtistReleaseLink read failed:', readError.message);
    return false;
  }

  const rows = (existingRows as { id: string }[] | null) || [];

  // A release can now hold several sources on one platform (two Discogs masters an admin
  // merged into one record). "Set this platform's link" has no single answer then, and picking
  // one at random would silently rewrite a URL the artist never looked at.
  if (rows.length > 1) {
    console.error('[DB] addArtistReleaseLink: release has multiple', platform, 'sources; refusing to guess');
    return false;
  }

  const write = rows.length === 1
    ? client.from('release_sources').update({ url, source: 'claimed', last_seen_at: new Date().toISOString() }).eq('id', rows[0].id)
    : client.from('release_sources').insert({ release_id: releaseId, platform, url, source: 'claimed', last_seen_at: new Date().toISOString() });

  const { error } = await write;

  if (error) {
    // The read above is not atomic with the write: two concurrent calls can both see zero rows
    // and both insert. `idx_release_sources_release_platform_external` — which two id-less rows
    // on one platform can never both satisfy — is what actually catches that, as a 23505 on the
    // insert we lost the race on. Whoever won gets treated as "already there"; fall back to
    // updating their row instead of failing the request.
    if (rows.length === 0 && error.code === '23505') {
      const { data: retryRows, error: retryError } = await client
        .from('release_sources')
        .select('id')
        .eq('release_id', releaseId)
        .eq('platform', platform)
        .is('external_id', null);

      if (retryError || (retryRows as { id: string }[] | null || []).length !== 1) {
        console.error('[DB] addArtistReleaseLink: conflict retry did not resolve to one row', retryError?.message);
        return false;
      }

      const { error: updateError } = await client
        .from('release_sources')
        .update({ url, source: 'claimed', last_seen_at: new Date().toISOString() })
        .eq('id', (retryRows as { id: string }[])[0].id);

      if (updateError) {
        console.error('[DB] addArtistReleaseLink conflict-retry update failed:', updateError.message);
        return false;
      }
      return true;
    }

    console.error('[DB] addArtistReleaseLink failed:', error.message);
    return false;
  }
  return true;
}

export interface NewArtistRelease {
  title: string;
  releaseType: string;
  releaseDate: string | null;
  platform: string;
  url: string;
}

export interface CreateReleaseResult {
  ok: boolean;
  error?: string;
  releaseId?: string;
}

/**
 * "Add a release we never found." A release row ingest has no idea exists, so unlike
 * everything else in this file it is never matched against `existing` — it's simply created,
 * fully curated from the start (ingest must never touch a hand-authored row).
 */
export async function createArtistRelease(artistId: string, input: NewArtistRelease): Promise<CreateReleaseResult> {
  const client = getClient();
  if (!client) return { ok: false, error: 'Database not configured' };

  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Title is required' };

  const matchKey = releaseMatchKey(title);
  if (!matchKey) return { ok: false, error: 'Title needs at least one letter or number' };

  const releaseType = mapReleaseType(input.releaseType);
  const now = new Date();
  const { date, precision } = input.releaseDate
    ? parseReleaseDate(input.releaseDate, now)
    : { date: null, precision: 'unknown' as const };

  try {
    const { data: existingSlugs, error: slugError } = await client
      .from('releases')
      .select('slug')
      .eq('artist_id', artistId);

    if (slugError) {
      console.error('[DB] createArtistRelease slug read failed:', slugError.message);
      return { ok: false, error: 'Failed to create release' };
    }

    const taken = new Set(((existingSlugs as { slug: string }[] | null) || []).map(r => r.slug));
    const slug = uniqueReleaseSlug(title, taken);

    const { data: inserted, error } = await client
      .from('releases')
      .insert({
        artist_id: artistId,
        title,
        slug,
        match_key: matchKey,
        release_type: releaseType,
        release_date: date,
        date_precision: precision,
        status: deriveStatus(date, false, now),
        source: 'claimed',
        curated_fields: ['title', 'release_date'],
      })
      .select('id')
      .single();

    if (error || !inserted) {
      console.error('[DB] createArtistRelease insert failed:', error?.message);
      return { ok: false, error: 'Failed to create release' };
    }

    const releaseId = (inserted as { id: string }).id;

    const { error: sourceError } = await client.from('release_sources').insert({
      release_id: releaseId,
      platform: input.platform,
      url: input.url,
      external_id: null,
      source: 'claimed',
    });

    if (sourceError) {
      console.error('[DB] createArtistRelease source insert failed:', sourceError.message);
      // The release itself was created — better to hand back a release missing its one link
      // than to lose the title/date/type the artist just entered.
      return { ok: true, releaseId };
    }

    return { ok: true, releaseId };
  } catch (error) {
    console.error('[DB] createArtistRelease error:', error);
    return { ok: false, error: 'Unexpected error' };
  }
}

// --- Bandcamp slug-probe cache (UNS-152) ---

export interface BandcampProbeRow {
  query_norm: string;
  artist_url: string | null;
  band_name: string | null;
  band_id: number | null;
  album_count: number;
  track_count: number;
  matched_slug: string | null;
  verdict: 'accepted' | 'absent' | 'rejected_empty' | 'rejected_name' | 'pending_review';
  /** Raw location string from the probed /music page, e.g. "Oxford, UK". */
  location: string | null;
  /** Normalized release titles from the probed /music page. */
  release_titles: string[] | null;
  /** Artist photo from the probed page's og:image. */
  image_url: string | null;
  /**
   * Slug candidates actually attempted in this probe round.
   *
   * `query_norm` strips punctuation, so "Morice" and "Mo-Rice" share one row —
   * but they generate different candidate sets (['morice'] vs
   * ['morice', 'mo-rice']). Without this, a negative recorded for the shorter
   * set is wrongly reused for the longer one, hiding a real artist. NULL means a
   * legacy row whose candidates are unknown.
   */
  probed_slugs: string[] | null;
  checked_at: string;
}

// Positives are stable — a Bandcamp URL rarely moves. Negatives expire, because
// an artist who wasn't on Bandcamp in March may well be by September.
const NEGATIVE_PROBE_TTL_DAYS = 30;

/**
 * True when a cached negative may be reused for a query that would probe `candidates`.
 *
 * A negative only means "none of the slugs we tried resolved". It says nothing about a
 * slug that was never tried — so it is reusable only if it covers every candidate the
 * current query would attempt. This is what keeps "Morice" (candidates ['morice'])
 * from answering for "Mo-Rice" (['morice', 'mo-rice']), which share a `query_norm`.
 *
 * A NULL `probed_slugs` is a pre-migration row: unknown coverage, so treat it as not
 * covering anything and let it be re-probed once.
 */
export function negativeCoversCandidates(
  probedSlugs: string[] | null,
  candidates: string[],
): boolean {
  if (!probedSlugs) return false;
  return candidates.every(c => probedSlugs.includes(c));
}

/**
 * Read a cached probe outcome. Returns null when there is no usable cache entry,
 * which is the caller's signal to probe.
 *
 * A stale negative returns null (re-probe); an accepted result never expires.
 * `pending_review` rows return as-is so an unverified account is neither
 * surfaced nor endlessly re-probed while it waits on /admin/verify.
 *
 * Pass `candidates` — the slugs this query would probe. A negative that does not
 * cover all of them is treated as a miss; see negativeCoversCandidates.
 */
export async function getBandcampProbe(
  queryNorm: string,
  candidates: string[] = [],
): Promise<BandcampProbeRow | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('bandcamp_slug_probes')
      .select('query_norm, artist_url, band_name, band_id, album_count, track_count, matched_slug, verdict, location, release_titles, image_url, probed_slugs, checked_at')
      .eq('query_norm', queryNorm)
      .maybeSingle();

    if (error) {
      console.error('[DB] Failed to read bandcamp probe cache:', error);
      return null;
    }
    if (!data) return null;

    const row = data as BandcampProbeRow;
    if (row.verdict === 'accepted' || row.verdict === 'pending_review') return row;

    const ageMs = Date.now() - new Date(row.checked_at).getTime();
    if (ageMs > NEGATIVE_PROBE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;

    // A negative from a narrower candidate set must not answer for a wider one.
    if (candidates.length > 0 && !negativeCoversCandidates(row.probed_slugs, candidates)) {
      console.log(`[DB] Re-probing: cached negative covered ${row.probed_slugs?.length ?? 0} slug(s), query needs ${candidates.length}`);
      return null;
    }

    return row;
  } catch (error) {
    console.error('[DB] getBandcampProbe error:', error);
    return null;
  }
}

/**
 * Persist a probe outcome, positive or negative.
 *
 * Callers must never pass an undecided outcome. A network error, timeout or bot
 * challenge means we don't know — writing that as a negative would turn a
 * transient outage into a permanent "this artist isn't on Bandcamp". The DB's
 * own CHECK constraint has no 'undecided' value, so this is enforced twice.
 */
export async function putBandcampProbe(
  row: Omit<BandcampProbeRow, 'checked_at'>,
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client
      .from('bandcamp_slug_probes')
      .upsert({ ...row, checked_at: new Date().toISOString() }, { onConflict: 'query_norm' });

    if (error) console.error('[DB] Failed to write bandcamp probe cache:', error);
  } catch (error) {
    console.error('[DB] putBandcampProbe error:', error);
  }
}

// --- Read Operations ---

/**
 * Resolve a retired slug to the slug that replaced it.
 *
 * A **separate** function rather than a fallback inside `getArtistBySlug`, deliberately.
 * `getArtistBySlug` runs at the front of every search and misses on almost all of them, so folding
 * an alias read into its miss path would add a round trip to nearly every query. Only the callers
 * that serve a URL — the artist page and the v1 lookup — should pay for it, and they call this after
 * `getArtistBySlug` has already returned null.
 *
 * Three outcomes, the same distinction `getArtistProfileBySlug` makes — a caller that can't tell
 * "that isn't an alias" from "the database didn't answer" turns an outage into a confident 404:
 *   { canonical }        — this slug is a known alias, canonical is live
 *   { canonical: null }  — genuinely not an alias
 *   { failed: true }     — the lookup itself failed (no client, query error, exception)
 *
 * Order matters and is the caller's responsibility: a **live** `artists.slug` always wins, so an
 * alias can never shadow a real artist that later takes that slug.
 */
export interface AliasResolution {
  canonical: string | null;
  failed: boolean;
}

export async function resolveArtistSlugAlias(slug: string): Promise<AliasResolution> {
  const client = getClient();
  // Missing credentials mean the database didn't answer, not that the slug isn't an alias.
  if (!client) return { canonical: null, failed: true };

  // Same guard as getArtistBySlug: stored slugs only ever hold [a-z0-9-], so anything else cannot
  // match, and rejecting it here keeps the value safe to interpolate into a PostgREST filter.
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return { canonical: null, failed: false };

  try {
    const { data, error } = await client
      .from('artist_slug_aliases')
      .select('artist_id, artists!inner(slug)')
      .eq('alias', slug.toLowerCase())
      .maybeSingle();

    if (error) {
      console.error('[DB] Failed to resolve artist slug alias:', error.message);
      return { canonical: null, failed: true };
    }
    const target = (data as { artists?: { slug?: string } } | null)?.artists?.slug;
    return { canonical: target ?? null, failed: false };
  } catch (error) {
    console.error('[DB] resolveArtistSlugAlias error:', error);
    return { canonical: null, failed: true };
  }
}

/**
 * Look up an artist by slug. Returns null if not found or Supabase is not configured.
 */
export async function getArtistBySlug(
  slug: string,
  opts?: { allowStale?: boolean },
): Promise<ArtistResult | null> {
  const client = getClient();
  if (!client) return null;

  // Stored slugs only ever contain [a-z0-9-] (see artistSlug). Anything else
  // can't match a real artist, and rejecting it here keeps the slug safe to
  // interpolate into the PostgREST or() filter below (no ilike wildcards or
  // filter-syntax characters).
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return null;

  try {
    // The lookup tolerates three slug variants, checked in priority order:
    //   1. exact match, 2. case-insensitive (e.g. "KingTriumph"),
    //   3. hyphens stripped ("king-triumph" → "kingtriumph"),
    //   4. hyphens added at camelCase boundaries ("kingTriumph" → "king-triumph").
    // They're fetched in ONE query — the old one-query-per-variant fallback
    // chain cost up to 4 sequential round-trips on every miss, and this
    // function runs at the front of every search.
    const noHyphens = slug.includes('-') ? slug.replace(/-/g, '') : null;
    const camelHyphenated = !slug.includes('-')
      ? slug.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
      : null;

    const orFilters = [`slug.ilike.${slug}`]; // ilike without wildcards = case-insensitive match, covers exact too
    if (noHyphens) orFilters.push(`slug.eq.${noHyphens}`);
    if (camelHyphenated && camelHyphenated !== slug) orFilters.push(`slug.eq.${camelHyphenated}`);

    const { data: candidates, error: artistError } = await client
      .from('artists')
      .select('*')
      .or(orFilters.join(','));

    if (artistError || !candidates || candidates.length === 0) return null;

    const rows = candidates as ArtistRow[];
    const lowerSlug = slug.toLowerCase();
    const artist =
      rows.find(r => r.slug === slug) ||
      rows.find(r => r.slug.toLowerCase() === lowerSlug) ||
      (noHyphens ? rows.find(r => r.slug === noHyphens) : undefined) ||
      (camelHyphenated ? rows.find(r => r.slug === camelHyphenated) : undefined);

    if (!artist) return null;

    const row = artist as ArtistRow;

    // Claimed artists are always fresh; auto-discovered artists expire.
    // allowStale skips the expiry: the partial-name discovery channel would
    // rather show a known artist with slightly old links than hide them —
    // platform URLs are stable, and an exact search refreshes the row anyway.
    if (row.match_confidence !== 'claimed' && !opts?.allowStale) {
      const updatedAt = new Date(row.updated_at).getTime();
      const now = Date.now();
      if (now - updatedAt > FRESHNESS_TTL_MS) {
        return null; // Stale, caller should refresh
      }
    }

    // Links and (for claimed artists) profile data are independent — fetch in parallel
    const [{ data: links, error: linksError }, { data: profileData }] = await Promise.all([
      client
        .from('artist_links')
        .select('*')
        .eq('artist_id', row.id)
        .order('display_order', { ascending: true, nullsFirst: false }),
      row.match_confidence === 'claimed'
        ? client
            .from('artist_profiles')
            .select('bio, custom_image_url, website_url, featured_embed, verified_at, link_dividers')
            .eq('artist_id', row.id)
            .single()
        : Promise.resolve({ data: null }),
    ]);

    if (linksError) return null;

    return artistRowToResult(row, (links as LinkRow[]) ?? [], profileData as ProfileRow | null);
  } catch (error) {
    console.error('[DB] getArtistBySlug error:', error);
    return null;
  }
}

interface ProfileRow {
  bio: string | null;
  custom_image_url: string | null;
  website_url: string | null;
  featured_embed: string | null;
  verified_at: string | null;
  link_dividers: number[] | null;
}

/**
 * The one place a stored artist row becomes an ArtistResult, shared by the single-slug and
 * batched lookups so the two can't drift in what a card carries.
 */
function artistRowToResult(row: ArtistRow, links: LinkRow[], profileData: ProfileRow | null): ArtistResult {
  const platforms: PlatformLink[] = links.map(link => ({
    sourceId: link.platform,
    url: link.url,
    ...(link.display_name ? { displayName: link.display_name } : {}),
    ...(link.latest_release ? { latestRelease: link.latest_release as PlatformLink['latestRelease'] } : {}),
  }));

  let profile: ArtistProfile | undefined;
  if (row.match_confidence === 'claimed' && profileData) {
    profile = {
      bio: profileData.bio || undefined,
      customImageUrl: profileData.custom_image_url || undefined,
      websiteUrl: profileData.website_url || undefined,
      featuredEmbed: profileData.featured_embed || undefined,
      verified: !!profileData.verified_at,
      ...(profileData.link_dividers?.length ? { linkDividers: profileData.link_dividers } : {}),
    };
  }

  const location = (row.city || row.country || row.country_code)
    ? {
        ...(row.city ? { city: row.city } : {}),
        ...(row.country ? { country: row.country } : {}),
        ...(row.country_code ? { countryCode: row.country_code } : {}),
      }
    : undefined;

  return {
    id: row.slug,
    name: row.name,
    type: 'artist',
    imageUrl: profile?.customImageUrl || row.image_url || undefined,
    platforms,
    matchConfidence: (row.match_confidence as ArtistResult['matchConfidence']) || undefined,
    profile,
    location,
  };
}

/**
 * The batched form of getArtistBySlug, for the name-contains search channel: it gets back up
 * to six slugs from findKnownArtistSlugsByName and used to resolve each one separately — 2-3
 * uncached queries per slug, so 12-18 reads inside every fuzzy search. This answers the whole
 * list in at most three: the artist rows, all their links, and the claimed ones's profiles.
 *
 * Exact slug match only, no variants: these slugs just came out of the artists table, so they
 * are stored spellings by construction. Freshness is deliberately not checked — the one caller
 * passed allowStale, for the reason documented on getArtistBySlug's allowStale option.
 */
export async function getArtistsBySlugs(slugs: string[]): Promise<Map<string, ArtistResult>> {
  const results = new Map<string, ArtistResult>();
  const client = getClient();
  if (!client) return results;

  // Same guard as getArtistBySlug: anything else can't match a stored slug.
  const safe = [...new Set(slugs.filter(s => /^[A-Za-z0-9-]+$/.test(s)))];
  if (safe.length === 0) return results;

  try {
    const { data: artistRows, error: artistError } = await client
      .from('artists')
      .select('*')
      .in('slug', safe);

    if (artistError || !artistRows || artistRows.length === 0) return results;
    const rows = artistRows as ArtistRow[];

    const claimedIds = rows.filter(r => r.match_confidence === 'claimed').map(r => r.id);
    const [{ data: links, error: linksError }, { data: profiles }] = await Promise.all([
      client
        .from('artist_links')
        .select('*')
        .in('artist_id', rows.map(r => r.id))
        .order('display_order', { ascending: true, nullsFirst: false }),
      claimedIds.length > 0
        ? client
            .from('artist_profiles')
            .select('artist_id, bio, custom_image_url, website_url, featured_embed, verified_at, link_dividers')
            .in('artist_id', claimedIds)
        : Promise.resolve({ data: [] }),
    ]);

    if (linksError) return results;

    const linksByArtist = new Map<string, LinkRow[]>();
    for (const link of (links as LinkRow[]) ?? []) {
      const list = linksByArtist.get(link.artist_id);
      if (list) list.push(link);
      else linksByArtist.set(link.artist_id, [link]);
    }
    const profileByArtist = new Map(
      ((profiles as (ProfileRow & { artist_id: string })[]) ?? []).map(p => [p.artist_id, p])
    );

    for (const row of rows) {
      results.set(
        row.slug,
        artistRowToResult(row, linksByArtist.get(row.id) ?? [], profileByArtist.get(row.id) ?? null)
      );
    }
    return results;
  } catch (error) {
    console.error('[DB] getArtistsBySlugs error:', error);
    return results;
  }
}

// --- Write Operations ---

// --- Typeahead suggestions ---

export interface ArtistSuggestion {
  slug: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Rank raw suggestion rows for a typeahead term: prefix matches first, then
 * shorter names, then alphabetical. Pure and exported for tests.
 */
export function rankArtistSuggestions(
  rows: { slug: string; name: string; image_url: string | null }[],
  term: string,
  limit: number,
): ArtistSuggestion[] {
  const termLower = term.toLowerCase();
  const seen = new Set<string>();
  return rows
    .filter(r => {
      if (!r.slug || !r.name || seen.has(r.slug)) return false;
      seen.add(r.slug);
      return true;
    })
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(termLower) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(termLower) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map(r => ({ slug: r.slug, name: r.name, imageUrl: r.image_url }));
}

/**
 * The exact term suggestArtists matches with: ILIKE wildcards stripped so user
 * input can't change the match shape (same reasoning as the slug guard in
 * getArtistBySlug). Exported so callers key caches on THIS string — a cache
 * key normalized any other way collides across inputs that query differently
 * ("sufjan-stevens" vs "sufjan stevens"), serving one spelling's results to
 * the other.
 */
export function cleanSuggestTerm(term: string): string {
  return term.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Name-substring lookup over artists Unstream has already resolved, for
 * search-as-you-type. Only verified/claimed rows are suggested — the artists
 * table accumulates whatever people search, and 'unverified' is where the
 * junk lives.
 *
 * Backed by the pg_trgm GIN index on artists.name (migration
 * 20260729071000_artist-name-trgm.sql); without it this ILIKE is a seq scan.
 *
 * Returns null when the DB could not be asked (no client, query error) —
 * callers must not cache that as "no suggestions".
 */
export async function suggestArtists(term: string, limit = 8): Promise<ArtistSuggestion[] | null> {
  const client = getClient();
  if (!client) return null;

  const cleaned = cleanSuggestTerm(term);
  if (cleaned.length < 2) return [];

  const { data, error } = await client
    .from('artists')
    .select('slug, name, image_url')
    .ilike('name', `%${cleaned}%`)
    .in('match_confidence', ['claimed', 'verified'])
    .limit(40);

  if (error) {
    console.error('[DB] suggestArtists error:', error);
    return null;
  }

  return rankArtistSuggestions(data ?? [], cleaned, limit);
}

/**
 * Slugs of artists Unstream already knows whose display name contains the term.
 *
 * The search handler's exact-slug lookup can only find an artist when the
 * query IS their name — a partial query like "lightbulbs" never resolves the
 * slug "kid-lightbulbs", and "patrick" never resolves "patrick-hardy" even
 * though a past exact search persisted his full result. This is the
 * name-contains channel that makes the accumulated artists table searchable.
 *
 * Claimed profiles come first (they replace generic results downstream), then
 * verified rows. 'unverified' rows are deliberately excluded — that's where
 * junk from name-only matches accumulates.
 */
export async function findKnownArtistSlugsByName(term: string, limit = 6): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  // Strip ILIKE wildcards so user input can't change the match shape
  // (same reasoning as the slug guard in getArtistBySlug).
  const cleaned = term.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) return [];

  const { data, error } = await client
    .from('artists')
    .select('slug, name, match_confidence')
    .ilike('name', `%${cleaned}%`)
    .in('match_confidence', ['claimed', 'verified'])
    .limit(40);

  if (error) {
    console.error('[DB] findKnownArtistSlugsByName error:', error);
    return [];
  }

  // Rank before capping — the query itself returns arbitrary rows, and for a
  // common name fragment ("patrick") the artist someone is typing toward must
  // not lose their slot to whichever rows Postgres happened to emit first.
  const termLower = cleaned.toLowerCase();
  return (data ?? [])
    .sort((a, b) => {
      const aClaimed = a.match_confidence === 'claimed' ? 0 : 1;
      const bClaimed = b.match_confidence === 'claimed' ? 0 : 1;
      if (aClaimed !== bClaimed) return aClaimed - bClaimed;
      const aPrefix = a.name.toLowerCase().startsWith(termLower) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(termLower) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.name.length - b.name.length;
    })
    .slice(0, limit)
    .map(r => r.slug)
    .filter(Boolean);
}

/**
 * Platforms whose URL identifies the artist's own catalogue, rather than a handle.
 *
 * Used as the evidence that an incoming search result is an artist we already have under a different
 * spelling. Socials and patronage are **deliberately excluded**, and that exclusion is the whole
 * reason this works. Measured across all 27 duplicate pairs on 2026-08-03:
 *
 *   - With socials included, `Honeycrush` and `Honey Crush` share `patreon.com/honeycrush`, and
 *     `Boto` and `Błoto` share `facebook.com/blotoquartet` — so both pairs look like one artist.
 *     They are not: those links were mis-attached by the homonym bug fixed in July, and using them
 *     as evidence would re-fuse exactly what that fix separated.
 *   - With only these platforms, both drop to "no evidence", `Tigercub`/`Tiger Cub` stays separate,
 *     and the genuine same-artist pairs still resolve — `Big Thief`/`Bigthief`,
 *     `Creepy Nuts`/`Creepynuts`, `Cry Wolf`/`Crywolf`, `I.O.I`/`Ioi`, `Rue Oberkampf`/`Rueoberkampf`
 *     all via a shared Discogs artist id or Bandcamp subdomain.
 */
const IDENTITY_PLATFORMS = new Set([
  'bandcamp', 'mirlo', 'jamcoop', 'faircamp', 'discogs', 'beatport', 'bandwagon', 'subvert', 'even', 'nina',
]);

/** At most this many URLs are checked per artist, to bound the query. Ordered by trustworthiness. */
const IDENTITY_LOOKUP_LIMIT = 3;

/**
 * The slug of an existing artist who already owns one of these platform URLs, or null.
 *
 * This is what stops a second row being created for an artist a different source spells differently.
 * `artistSlug` derives the slug from whichever name won aggregation, and that varies between
 * searches with which platforms answered — so "Big Thief" and "Bigthief" became two rows, two pages
 * and two half-populated link sets. Matching on a shared catalogue URL says "this is the artist we
 * already have" without ever claiming two similarly-named artists are one.
 *
 * Returns null when **nothing** matches (a genuinely new artist) and also when **more than one**
 * artist matches. Two artists sharing an identity URL means the data is already wrong somewhere;
 * quietly picking one would attach this result to a coin-flip. Falling through creates the row under
 * its own slug, which is today's behaviour.
 *
 * Called only when no row exists at the computed slug — i.e. only when a new row would otherwise be
 * minted. `persistSearchResults` is awaited before the search response is sent, so an already-known
 * artist must not pay for this.
 */
async function findArtistSlugByIdentityUrl(
  client: SupabaseClient,
  platforms: { sourceId: string; url: string }[],
): Promise<string | null> {
  const urls = platforms
    .filter(p => IDENTITY_PLATFORMS.has(p.sourceId))
    .slice(0, IDENTITY_LOOKUP_LIMIT);
  if (urls.length === 0) return null;

  // Coarse prefilter on host+path, so a row stored as http://, with a www. prefix, or with a
  // trailing slash is still a candidate — measured: of 4,782 stored identity links, 2,804 carry
  // www. and 581 a trailing slash, so exact matching would miss a large share. Same escaping as
  // deleteStoredLinksForUrl: ilike treats % and _ as wildcards and a URL may contain either.
  const filters = urls.map(
    p => `url.ilike.%${urlMatchPrefilter(p.url).replace(/[%_\\]/g, m => `\\${m}`)}%`,
  );

  try {
    const { data, error } = await client
      .from('artist_links')
      .select('artist_id, url, artists!inner(slug)')
      .in('platform', [...IDENTITY_PLATFORMS])
      .or(filters.join(','));

    if (error) {
      console.error('[DB] identity-url lookup failed:', error.message);
      return null;
    }

    // The prefilter is a substring match, so confirm each hit on the normalized URL before trusting
    // it — otherwise `discogs.com/artist/123` would match `discogs.com/artist/1234`.
    const wanted = new Set(urls.map(p => normalizeUrlForMatch(p.url)));
    const slugs = new Set<string>();
    for (const row of (data ?? []) as { url: string; artists?: { slug?: string } }[]) {
      if (!wanted.has(normalizeUrlForMatch(row.url))) continue;
      if (row.artists?.slug) slugs.add(row.artists.slug);
    }

    if (slugs.size !== 1) return null;
    return [...slugs][0];
  } catch (error) {
    console.error('[DB] findArtistSlugByIdentityUrl error:', error);
    return null;
  }
}

/**
 * The slug of an artist who already holds this Bandcamp URL, or null.
 *
 * The single-URL case of `findArtistSlugByIdentityUrl`, exported for the collection matcher.
 * An artist discovered from a fan's Bandcamp collection is often one we already hold under a
 * different spelling — the collection carries Bandcamp's spelling, the stored row carries
 * whichever name won aggregation — and creating a second row would split their releases across
 * two pages exactly as "Big Thief" / "Bigthief" once did.
 */
export async function findArtistSlugByBandcampUrl(url: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  return findArtistSlugByIdentityUrl(client, [{ sourceId: 'bandcamp', url }]);
}

/**
 * Persist artist search results to the database.
 * Only persists artist-type results. Runs as fire-and-forget after search.
 */
/** A link row as persistSearchResults builds it, before it goes to Postgres. */
interface LinkRowToWrite {
  artist_id: string;
  platform: string;
  url: string;
  source: string;
  is_direct: boolean;
  latest_release: unknown;
  display_order: number;
}

/**
 * Key-order-independent comparison for the one jsonb column involved (`latest_release`).
 *
 * We build the object in JS and compare it against what PostgREST hands back, and nothing
 * guarantees the two serialize their keys in the same order — so a plain JSON.stringify compare
 * would report "changed" constantly and defeat the whole point.
 *
 * Deliberately biased: anything this can't confidently prove identical is reported as *different*.
 * A false "different" costs one unnecessary write; a false "same" would skip a real update and
 * leave stale data on an artist's page, which is the far worse failure.
 */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJsonValue(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every(k => sameJsonValue(aObj[k], bObj[k]));
}

/**
 * Narrow a set of link rows to the ones that would actually change something.
 *
 * One indexed read replaces up to N row rewrites. Returns every row unchanged if the read fails —
 * failing towards "write it" keeps the old behaviour rather than silently dropping a real update
 * because a lookup blipped.
 */
async function filterUnchangedLinks(
  client: SupabaseClient,
  artistId: string,
  rows: LinkRowToWrite[]
): Promise<LinkRowToWrite[]> {
  if (rows.length === 0) return rows;

  const { data, error } = await client
    .from('artist_links')
    .select('platform, url, source, is_direct, latest_release, display_order')
    .eq('artist_id', artistId);

  if (error) {
    console.error('[DB] filterUnchangedLinks read failed, writing all links:', error.message);
    return rows;
  }

  type StoredLink = Omit<LinkRowToWrite, 'artist_id'>;
  const stored = new Map<string, StoredLink>();
  for (const row of (data as StoredLink[]) || []) stored.set(row.platform, row);

  return rows.filter(row => {
    const prior = stored.get(row.platform);
    if (!prior) return true;
    return !(
      prior.url === row.url &&
      prior.source === row.source &&
      prior.is_direct === row.is_direct &&
      prior.display_order === row.display_order &&
      sameJsonValue(prior.latest_release, row.latest_release)
    );
  });
}

/**
 * Persist the artists and links a search turned up.
 *
 * **This does not request release cataloging, deliberately.** It used to: every search handed
 * every Bandcamp-linked artist in its results to `requestArtistCatalog(..., 'searched')`, which
 * made an unauthenticated, traffic-driven path the largest producer of database writes on the
 * site — up to `CATALOG_HOURLY_CAP.searched` (60) full first-time crawls an hour, against the
 * scheduled sweep's 100 a *day*. Each of those crawls inserts a row per release, a row per
 * release source and a row or three per offer, into three six-index tables, and then re-reads
 * every one of them on the 30-day detail refresh. That is what exhausted the Supabase disk I/O
 * budget; see docs/specs/supabase-disk-io-investigation.md for the numbers and the SQL that
 * confirms it.
 *
 * Cataloging still happens, just from bounded triggers: a save, an artist's own button, the
 * admin command, a Bandcamp collection import, and the six-hourly sweep — whose pool is every
 * artist with a catalogue-able link, so a searched artist is still reached, within about a
 * month rather than within a minute. The cost of that trade is coverage latency on a brand-new
 * artist page, not lost coverage.
 *
 * Do not reintroduce a search-time trigger without a per-run budget that is measured against
 * the disk I/O headroom, not just against what Bandcamp will tolerate.
 */
export async function persistSearchResults(results: ArtistResult[]): Promise<void> {
  const client = getClient();
  if (!client) return;

  // Search does NOT trigger release cataloging. See the note above persistSearchResults.

  // This runs before the search response is sent, so wall-clock time matters:
  // artists persist concurrently, and each artist's links go up in one bulk
  // upsert instead of one round-trip per link.
  await Promise.all(results.map(async result => {
    if (result.type !== 'artist') return;

    // Filter out excluded platforms and non-direct links
    const validPlatforms = result.platforms.filter(
      p => !EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url)
    );

    // Only persist artists with at least 1 real direct link
    if (validPlatforms.length === 0) return;

    let slug = artistSlug(result.name);

    // Software products, brands and TV shows can carry a MusicBrainz entry and a Beatport
    // listing, and the pipeline's default verdict is 'verified', so without this gate one
    // search mints them a permanent /artist/ page. Checked here rather than earlier because
    // the search response may still legitimately show what it found — it is the durable row
    // that must not exist. See api/lib/non-artist-names.ts.
    if (isNonArtistSlug(slug)) {
      console.log(`[DB] Skipping persist for non-artist "${result.name}" (${slug})`);
      return;
    }

    // Acts excluded on ethical grounds — a separate, editorial list. See api/lib/excluded-artists.ts.
    if (isExcludedArtistSlug(slug)) {
      console.log(`[DB] Skipping persist for excluded artist "${result.name}" (${slug})`);
      return;
    }

    try {
      // Check if this artist is already claimed — never overwrite claimed status.
      // `name`, `image_url` and `updated_at` come back too, so the write below can be skipped
      // when it would change nothing. See PERSIST_REFRESH_FLOOR_MS.
      const { data: existing } = await client
        .from('artists')
        .select('id, name, image_url, match_confidence, updated_at')
        .eq('slug', slug)
        .single();

      // No row at this slug, so a new one is about to be created. Before doing that, check whether
      // we already hold this artist under a different spelling — different sources spell one artist
      // differently ("Big Thief" vs "Bigthief"), the slug follows whichever name won aggregation, and
      // the result was two rows and two half-populated pages. Only reached on the create path, so a
      // known artist pays nothing for it.
      if (!existing) {
        const owned = await findArtistSlugByIdentityUrl(client, validPlatforms);
        if (owned && owned !== slug) {
          console.log(`[DB] "${result.name}" already stored as "${owned}" — reusing that row instead of creating ${slug}`);
          slug = owned;
          // Re-check the claimed guard against the row we are now writing to: that row may be a
          // claimed profile, and skipping this would let a stranger's search overwrite it.
          const { data: owner } = await client
            .from('artists')
            .select('match_confidence')
            .eq('slug', slug)
            .single();
          if (owner?.match_confidence === 'claimed') {
            console.log(`[DB] Skipping persist for claimed artist "${result.name}" (matched via ${slug})`);
            return;
          }
        }
      }

      if (existing?.match_confidence === 'claimed') {
        console.log(`[DB] Skipping persist for claimed artist "${result.name}"`);
        return;
      }

      // Upsert artist, keeping the pipeline's verdict. This used to hardcode
      // 'unverified', which made the stored confidence meaningless — every
      // non-claimed row was 'unverified' forever, so quality filters over the
      // table (partial-name discovery, typeahead) could never distinguish a
      // release-corroborated artist from name-match junk. Rows refresh on
      // every search, so the stored verdict tracks the latest pipeline run.
      const matchConfidence = result.matchConfidence === 'verified' ? 'verified' : 'unverified';
      const imageUrl = result.imageUrl || null;

      let artistId: string;

      if (existing && !artistNeedsRefresh(existing, result.name, imageUrl, matchConfidence)) {
        // Nothing to say about this artist that the row doesn't already say, and it was
        // refreshed recently enough that `updated_at` doesn't need moving. Skipping the write
        // is the point: see artistNeedsRefresh.
        artistId = existing.id;
      } else {
        const { data: artist, error: artistError } = await client
          .from('artists')
          .upsert(
            {
              slug,
              name: result.name,
              image_url: imageUrl,
              match_confidence: matchConfidence,
              source: 'auto',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'slug' }
          )
          .select('id')
          .single();

        if (artistError || !artist) {
          console.error(`[DB] Failed to upsert artist "${result.name}":`, artistError);
          return;
        }

        artistId = artist.id;
      }

      // Bulk-upsert links (only valid platforms) in a single request.
      // Deduped by platform (last wins, matching the old one-at-a-time loop) —
      // Postgres rejects a bulk upsert that touches the same conflict key twice.
      const linkRowsByPlatform = new Map(validPlatforms.map((platform, index) => [
        platform.sourceId,
        {
          artist_id: artistId,
          platform: platform.sourceId,
          url: platform.url,
          source: 'search',
          is_direct: true,
          latest_release: platform.latestRelease || null,
          display_order: index,
        },
      ]));
      const linkRows = [...linkRowsByPlatform.values()];

      // Only write links that would actually differ from what's stored.
      //
      // This bulk upsert used to run on every search, rewriting every one of an artist's link
      // rows whether or not anything had moved — and platform URLs almost never move. That is the
      // larger half of the churn described on PERSIST_REFRESH_FLOOR_MS, because it is N rows per
      // artist per search rather than one.
      //
      // Unlike `artists.updated_at`, nothing reads `artist_links.updated_at` as a freshness
      // signal, so an unchanged link row genuinely has no reason to be touched and there is no
      // throttle here — just a comparison. The read that makes the comparison possible is one
      // indexed lookup on `idx_artist_links_artist_id`, which is far cheaper than the writes it
      // avoids: a read costs no WAL, no index maintenance and no dead tuples.
      const changedLinkRows = existing
        ? await filterUnchangedLinks(client, artistId, linkRows)
        : linkRows;

      if (changedLinkRows.length > 0) {
        const { error: linkError } = await client
          .from('artist_links')
          .upsert(changedLinkRows, { onConflict: 'artist_id,platform' });

        if (linkError) {
          console.error(`[DB] Failed to upsert links for "${result.name}":`, linkError);
        }
      }

      console.log(
        `[DB] Persisted "${result.name}": ${changedLinkRows.length} of ${linkRows.length} links written`
      );
    } catch (error) {
      console.error(`[DB] Error persisting "${result.name}":`, error);
    }
  }));
}

/**
 * Persist MusicBrainz enrichment data for an artist.
 */
export async function persistEnrichment(
  artistName: string,
  mbData: {
    officialUrl: string | null;
    discogsUrl: string | null;
    hasPre2005Release: boolean;
    socialLinks: { platform: string; url: string }[];
    discoveredPlatforms?: { platform: string; url: string }[];
    location?: { city?: string; country?: string; countryCode?: string };
  }
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const slug = artistSlug(artistName);

  try {
    // Find the artist
    const { data: artist, error: findError } = await client
      .from('artists')
      .select('id, match_confidence')
      .eq('slug', slug)
      .single();

    if (findError || !artist) {
      // Artist not in DB yet (search hasn't been persisted). That's OK.
      return;
    }

    // Never overwrite links for claimed artists — they manage their own links
    if (artist.match_confidence === 'claimed') {
      console.log('[DB] Skipping enrichment for a claimed artist');
      return;
    }

    const artistId = artist.id;

    // Build enrichment links
    const enrichmentLinks: { platform: string; url: string }[] = [];

    if (mbData.officialUrl) {
      enrichmentLinks.push({ platform: 'officialsite', url: mbData.officialUrl });
    }
    if (mbData.discogsUrl) {
      enrichmentLinks.push({ platform: 'discogs', url: mbData.discogsUrl });
    }
    if (mbData.hasPre2005Release) {
      enrichmentLinks.push({
        platform: 'hoopla',
        url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(artistName)}&type=music`,
      });
      enrichmentLinks.push({
        platform: 'freegal',
        url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(artistName)}`,
      });
    }

    for (const social of mbData.socialLinks || []) {
      enrichmentLinks.push({ platform: social.platform, url: social.url });
    }
    for (const discovered of mbData.discoveredPlatforms || []) {
      enrichmentLinks.push({ platform: discovered.platform, url: discovered.url });
    }

    // Upsert each enrichment link (skip excluded platforms and non-direct URLs)
    for (const link of enrichmentLinks.filter(l => !EXCLUDED_PLATFORMS.has(l.platform) && isDirectLink(l.url))) {
      const { error } = await client
        .from('artist_links')
        .upsert(
          {
            artist_id: artistId,
            platform: link.platform,
            url: link.url,
            source: 'musicbrainz',
            is_direct: isDirectLink(link.url),
          },
          { onConflict: 'artist_id,platform', ignoreDuplicates: false }
        );

      if (error) {
        console.error(`[DB] Failed to upsert enrichment link ${link.platform}:`, error);
      }
    }

    // Mark artist as enriched; persist location if discovered
    const artistUpdate: {
      last_enriched_at: string;
      city?: string | null;
      country?: string | null;
      country_code?: string | null;
    } = { last_enriched_at: new Date().toISOString() };

    if (mbData.location) {
      artistUpdate.city = mbData.location.city ?? null;
      artistUpdate.country = mbData.location.country ?? null;
      artistUpdate.country_code = mbData.location.countryCode ?? null;
    }

    await client
      .from('artists')
      .update(artistUpdate)
      .eq('id', artistId);

    const locationLog = mbData.location ? ` + location` : '';
    console.log(`[DB] Enriched with ${enrichmentLinks.length} MusicBrainz links${locationLog}`);
  } catch (error) {
    console.error('[DB] Error enriching artist:', error);
  }
}

// --- Releases for an artist page ---

export interface ArtistPageRelease {
  slug: string;
  title: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  status: string;
  artworkUrl: string | null;
  // Platform attribution kept per-source (not flattened) so the UI can show *where* a release
  // is available, not just the cheapest number across everywhere it happens to be sold.
  sources: { platform: string; offers: { price: number | null; currency: string | null; availability: string }[] }[];
}

/**
 * An artist's releases for their page, in the artist's order where they set one and newest
 * first otherwise, plus the total.
 *
 * `count: 'exact'` rides along with the limit in one round trip, so an "and N more" line is a
 * real number rather than a guess. The chronological part of the ordering matches
 * idx_releases_artist_chrono: many releases have no date yet — grid ingest gets identity and
 * artwork but no dates — and without the created_at tiebreaker those undated rows would shuffle
 * between requests.
 *
 * `display_order` leads, NULLS LAST: it's null for every release until a claimed artist arranges
 * their catalogue on /artist-edit/:slug/releases, so this is unchanged behaviour for everyone
 * else. Sorted in SQL rather than after the fetch on purpose — re-sorting a date-limited page in
 * JS would drop a release the artist had pinned to the top out of the query entirely.
 *
 * Hidden releases are filtered in the query rather than after, so a suppressed release is
 * indistinguishable from one that was never catalogued. That's the point of the column.
 */
export async function getArtistReleases(
  artistId: string,
  limit: number
): Promise<{ releases: ArtistPageRelease[]; total: number }> {
  const client = getClient();
  if (!client) return { releases: [], total: 0 };

  try {
    const { data, count, error } = await client
      .from('releases')
      .select(
        'slug, title, release_type, release_date, date_precision, status, artwork_url,' +
        ' release_sources ( platform, release_offers ( price, currency, availability ) )',
        { count: 'exact' }
      )
      .eq('artist_id', artistId)
      .eq('is_hidden', false)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('release_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[DB] getArtistReleases failed:', error.message);
      return { releases: [], total: 0 };
    }

    type Row = {
      slug: string;
      title: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
      }[] | null;
    };

    // Through `unknown`: PostgREST types a nested select as a union that includes an error
    // shape, so a direct cast is rejected. The runtime shape is checked by the query above.
    const releases = ((data as unknown as Row[]) || []).map(r => ({
      slug: r.slug,
      title: r.title,
      releaseType: r.release_type,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      status: r.status,
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({ platform: s.platform, offers: s.release_offers || [] })),
    }));

    return { releases, total: count ?? releases.length };
  } catch (error) {
    console.error('[DB] getArtistReleases error:', error);
    return { releases: [], total: 0 };
  }
}

// --- One release's buying guide ---

/** One format on one platform: what it is, what it costs, and whether you can still get it. */
export interface ReleaseDetailOffer {
  format: string;
  price: number | null;
  currency: string | null;
  availability: string;
  capturedAt: string;
}

export interface ReleaseDetailSource {
  platform: string;
  /** The platform's own page for this release — where "Buy" actually goes. */
  url: string;
  /** When this platform's page was last read for prices. Null means never, which is not the
   *  same as "it has no formats" — the caller has to be able to tell those apart. */
  detailCheckedAt: string | null;
  offers: ReleaseDetailOffer[];
}

export interface ReleaseDetail {
  artist: { slug: string; name: string; imageUrl: string | null };
  release: {
    slug: string;
    title: string;
    releaseType: string;
    releaseDate: string | null;
    datePrecision: string | null;
    status: string;
    artworkUrl: string | null;
    sources: ReleaseDetailSource[];
  };
}

/**
 * Three outcomes, deliberately distinguishable, for the same reason `getArtistProfileBySlug`
 * distinguishes them: a caller that can't tell "no such release" from "the database didn't
 * answer" turns a Supabase outage into a wall of convincing 404s.
 *   { detail }           — found
 *   { detail: null }     — no such artist, or no such (visible) release under them
 *   { failed: true }     — the lookup itself failed
 */
export interface ReleaseDetailLookup {
  detail: ReleaseDetail | null;
  failed: boolean;
}

/**
 * Everything the buying guide for one release needs — the same query
 * `api/edge/release-page.ts` runs, because this is that page's JSON twin and a native client
 * must not describe a release differently from the web page at the same URL.
 *
 * Two filters, and the asymmetry between them is the point:
 *   - `is_hidden` is filtered, in the query rather than after, so a release an artist has
 *     deliberately suppressed is indistinguishable from one that was never catalogued.
 *   - `needs_review` is deliberately **not** filtered, unlike the alert and feed reads. A
 *     tier-3 fuzzy flag means "we aren't sure this release is *distinct*", not "this is
 *     wrong". That's a good reason to keep it out of someone's calendar and a bad reason to
 *     404 a person who followed a direct link to it.
 *
 * Ordering is left to the caller: sorting by payout needs the platform registry, which this
 * data layer deliberately knows nothing about.
 */
export async function getReleaseDetail(
  artistSlugValue: string,
  releaseSlugValue: string
): Promise<ReleaseDetailLookup> {
  const client = getClient();
  // Missing credentials mean we can't answer, not that the release doesn't exist.
  if (!client) return { detail: null, failed: true };

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, name, image_url')
      .eq('slug', artistSlugValue)
      .maybeSingle();

    if (artistError) {
      console.error('[DB] getReleaseDetail artist read failed:', artistError.message);
      return { detail: null, failed: true };
    }
    if (!artist) return { detail: null, failed: false };
    const artistRow = artist as { id: string; name: string; image_url: string | null };

    // One round trip for the release, its sources and their offers. Scoped by `artist_id`
    // rather than by joining on the artist slug, because a release slug is only unique per
    // artist — two artists can each have a `self-titled`.
    const { data, error } = await client
      .from('releases')
      .select(
        'slug, title, release_type, release_date, date_precision, status, artwork_url,' +
        ' release_sources ( platform, url, source, detail_checked_at,' +
        ' release_offers ( format, price, currency, availability, captured_at ) )'
      )
      .eq('artist_id', artistRow.id)
      .eq('slug', releaseSlugValue)
      .eq('is_hidden', false)
      .maybeSingle();

    if (error) {
      console.error('[DB] getReleaseDetail release read failed:', error.message);
      return { detail: null, failed: true };
    }
    if (!data) return { detail: null, failed: false };

    type Row = {
      slug: string;
      title: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        url: string;
        source: string | null;
        detail_checked_at: string | null;
        release_offers: {
          format: string;
          price: number | null;
          currency: string | null;
          availability: string;
          captured_at: string;
        }[] | null;
      }[] | null;
    };

    // Through `unknown`: PostgREST types a nested select as a union that includes an error
    // shape, so a direct cast is rejected. The runtime shape is checked by the query above.
    const row = data as unknown as Row;

    return {
      detail: {
        artist: { slug: artistSlugValue, name: artistRow.name, imageUrl: artistRow.image_url },
        release: {
          slug: row.slug,
          title: row.title,
          releaseType: row.release_type,
          releaseDate: row.release_date,
          datePrecision: row.date_precision,
          status: row.status,
          artworkUrl: row.artwork_url,
          // One row per platform, matching the edge page exactly — this is that page's JSON
          // twin, and a release an admin merged out of two Discogs masters must not describe
          // itself differently to a native client than it does on the web.
          sources: oneSourcePerPlatform(row.release_sources || []).map(s => ({
            platform: s.platform,
            url: s.url,
            detailCheckedAt: s.detail_checked_at,
            offers: (s.release_offers || []).map(o => ({
              format: o.format,
              price: o.price,
              currency: o.currency,
              availability: o.availability,
              capturedAt: o.captured_at,
            })),
          })),
        },
      },
      failed: false,
    };
  } catch (error) {
    console.error('[DB] getReleaseDetail error:', error);
    return { detail: null, failed: true };
  }
}

// --- Releases for alerts ---

export interface AlertRelease {
  /** Release slug, for building the /a/{artist}/{release} link an alert points at. */
  slug: string;
  title: string;
  releaseDate: string | null;
  datePrecision: string | null;
  status: string;
  artworkUrl: string | null;
  sources: {
    platform: string;
    /** The platform's own page for this release — the fallback link when a fan wants the source. */
    url: string;
    offers: { price: number | null; currency: string | null; availability: string }[];
  }[];
}

export interface AlertReleases {
  /** The catalogued artist's slug, which may differ from the caller's derived one. */
  artistSlug: string;
  releases: AlertRelease[];
}

/**
 * Everything an alert needs for one artist, straight out of the catalog.
 *
 * **Returns null when this artist has no catalog at all, and `[]` when they have one with
 * nothing new in it.** Those are different facts and the caller depends on the difference: the
 * first means "we haven't looked yet, go and scrape" and the second means "we looked and there
 * is genuinely nothing". Collapsing them into an empty array is the single most repeated bug
 * class in this codebase, and here it would either silently stop alerting for every artist
 * without a catalog, or re-scrape Bandcamp for every artist forever.
 *
 * The window is a floor, not a range. Anything dated on or after `today - windowDays` qualifies,
 * **including releases dated in the future** — which is the whole point of the fix. The old
 * client-side check required `daysDiff >= 0`, so a pre-announced record was filtered out for
 * being in the future and then aged past the window before it ever became "recent"; the most
 * delightful possible alert ("your artist just announced an album for September") could not fire
 * at all. Undated releases are excluded: with no date there is nothing to say is new, and grid
 * ingest produces plenty of them.
 *
 * Strictly chronological, and `releases.display_order` deliberately does not apply — that's not
 * an oversight. An artist's manual arrangement answers "what should fans see first on my page";
 * an alert answers "what came out". Honouring the arrangement here would let a pinned back
 * catalogue release be announced as the new one, and `release[0]` — which the shipped Mac app
 * and extension read as *the* new release — would stop meaning newest.
 */
export async function getReleasesForAlerts(
  artistName: string,
  windowDays: number,
  now: Date = new Date()
): Promise<AlertReleases | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, slug')
      .eq('slug', artistSlug(artistName))
      .maybeSingle();

    if (artistError) {
      console.error('[DB] getReleasesForAlerts artist lookup failed:', artistError.message);
      return null;
    }
    if (!artist) return null;

    const { id, slug } = artist as { id: string; slug: string };

    // Has this artist ever been catalogued? Asked separately from the windowed read because a
    // catalogued artist with a quiet month and an artist nobody has ever crawled produce the
    // same empty result set, and only the second one should trigger a live scrape.
    const { count: catalogued, error: countError } = await client
      .from('releases')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', id);

    if (countError) {
      console.error('[DB] getReleasesForAlerts count failed:', countError.message);
      return null;
    }
    if (!catalogued) return null;

    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);

    const { data, error } = await client
      .from('releases')
      .select(
        'slug, title, release_date, date_precision, status, artwork_url,' +
        ' release_sources ( platform, url, release_offers ( price, currency, availability ) )'
      )
      .eq('artist_id', id)
      .eq('is_hidden', false)
      // A tier-3 fuzzy flag means we are not sure this is a distinct record. Sending a push
      // notification about it would publish that uncertainty to a fan's lock screen, so flagged
      // rows wait for the review queue rather than alerting.
      .eq('needs_review', false)
      .gte('release_date', since)
      .order('release_date', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[DB] getReleasesForAlerts read failed:', error.message);
      return null;
    }

    type Row = {
      slug: string;
      title: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: {
        platform: string;
        url: string;
        release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
      }[] | null;
    };

    const releases = ((data as unknown as Row[]) || []).map(r => ({
      slug: r.slug,
      title: r.title,
      releaseDate: r.release_date,
      datePrecision: r.date_precision,
      status: r.status,
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({
        platform: s.platform,
        url: s.url,
        offers: s.release_offers || [],
      })),
    }));

    return { artistSlug: slug, releases };
  } catch (error) {
    console.error('[DB] getReleasesForAlerts error:', error);
    return null;
  }
}

// --- Release feeds (/feed/f/{token}.ics) ---

/**
 * Look up whose feed this token is.
 *
 * The token *is* the authorization — a calendar client sends no session — so this is the whole
 * auth check for the feed path. Returns null for an unknown token, which the caller must turn
 * into a 404 rather than a 401: a 401 invites retrying with a different token, and confirming
 * "this token shape exists but is wrong" is more than an anonymous caller needs to know.
 *
 * Never log the token. It's a credential in a URL, and path tokens end up in access logs and
 * referrers by default (spec §8).
 */
export async function getFeedTokenOwner(token: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('release_feed_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('[DB] getFeedTokenOwner failed:', error.message);
      return null;
    }
    return data ? (data as { user_id: string }).user_id : null;
  } catch (error) {
    console.error('[DB] getFeedTokenOwner error:', error);
    return null;
  }
}

/** The user's existing feed token, or null if they've never made one. */
export async function getFeedToken(userId: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('release_feed_tokens')
      .select('token')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[DB] getFeedToken failed:', error.message);
      return null;
    }
    return data ? (data as { token: string }).token : null;
  } catch (error) {
    console.error('[DB] getFeedToken error:', error);
    return null;
  }
}

/**
 * Issue a feed token, replacing any existing one.
 *
 * Upsert on `user_id` rather than insert-then-delete, so rotation is a single statement and
 * there is never a window where the user has no token at all. The caller generates the value —
 * `crypto.randomBytes` lives at the endpoint, keeping this module free of the "how much entropy"
 * decision.
 */
export async function setFeedToken(userId: string, token: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { error } = await client
      .from('release_feed_tokens')
      .upsert(
        { user_id: userId, token, rotated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (error) {
      console.error('[DB] setFeedToken failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] setFeedToken error:', error);
    return false;
  }
}

/** Revoke the user's feed token entirely, breaking every existing subscription. */
export async function deleteFeedToken(userId: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { error } = await client.from('release_feed_tokens').delete().eq('user_id', userId);
    if (error) {
      console.error('[DB] deleteFeedToken failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] deleteFeedToken error:', error);
    return false;
  }
}

export interface FeedReleaseRow {
  artistName: string;
  artistSlug: string;
  title: string;
  releaseSlug: string;
  releaseDate: string;
  /**
   * How precisely `releaseDate` is actually known. MusicBrainz gives year- and month-only dates,
   * and the dashboard prints the date in words — so it needs this to avoid claiming "1 January
   * 2023" for a release we only know the year of. The feeds place an event *on* the date and
   * have nothing finer to say, so they ignore it.
   */
  datePrecision: string | null;
  offerSummary: string;
  platforms: string[];
  /** Cover art, so a feed entry can show the record rather than just name it. */
  artworkUrl: string | null;
  sources: {
    platform: string;
    /** The platform's own page. Feed entries link each platform rather than listing dead names. */
    url: string;
    offers: { price: number | null; currency: string | null; availability: string }[];
  }[];
}

/**
 * How far back a feed reaches. Spec §3 argues for upcoming releases only ("a calendar of past
 * releases is a changelog"), and that argument is right about the *back catalogue* — but a
 * record that came out last week is still something a subscriber may not have bought yet, which
 * is the same purchase-intent moment the alerts serve. A short trailing window keeps that case
 * and stops the feed reading as broken while catalog coverage is still thin.
 */
export const FEED_TRAILING_DAYS = 30;

/** Cap on events in one feed, so a fan with hundreds of saved artists still gets a usable file. */
const FEED_MAX_RELEASES = 200;

// Every feed read below is ordered by date, and `releases.display_order` deliberately does not
// apply to any of them. A calendar is keyed on dates and a reader sorts an Atom feed by them, so
// an artist's page arrangement has nothing to say here — the same line drawn for alerts above.

type FeedQueryRow = {
  slug: string;
  title: string;
  release_date: string | null;
  date_precision: string | null;
  artwork_url: string | null;
  artists: { name: string; slug: string } | null;
  release_sources: {
    platform: string;
    url: string;
    release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
  }[] | null;
};

function toFeedRows(rows: FeedQueryRow[]): FeedReleaseRow[] {
  return rows
    .filter(r => r.release_date && r.artists)
    .map(r => ({
      artistName: r.artists!.name,
      artistSlug: r.artists!.slug,
      title: r.title,
      releaseSlug: r.slug,
      releaseDate: r.release_date!,
      datePrecision: r.date_precision,
      offerSummary: '',
      platforms: [],
      artworkUrl: r.artwork_url,
      sources: (r.release_sources || []).map(s => ({
        platform: s.platform,
        url: s.url,
        offers: s.release_offers || [],
      })),
    }));
}

const FEED_SELECT =
  'slug, title, release_date, date_precision, artwork_url, artists!inner ( name, slug ),' +
  ' release_sources ( platform, url, release_offers ( price, currency, availability ) )';

/** Soonest first — a calendar and a reader both want the next thing at the top. */
function feedSince(now: Date): string {
  return new Date(now.getTime() - FEED_TRAILING_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve the artists this user has saved, to artist-table ids.
 *
 * **`saved_artists.artist_id` alone is not enough, and assuming it was is how the dashboard
 * shipped empty.** The column is populated only when the save request's slug matched an artists
 * row at the time; a save made from a search result used to send a synthetic key
 * (`rodneyowl`, `qobuz-pearljam`, `nameonly-…`), which matched nothing, so the row was written
 * with `artist_id: null`. Measured 2026-08-07: **25 of 37 live rows**. Every feature keyed on
 * `artist_id` — this feed, the /dashboard shortlist — was silently blind to two thirds of
 * everyone's saved artists.
 *
 * The client that wrote those keys is fixed, but the rows are already in the database and a
 * fan's calendar should not stay wrong until a backfill runs. So `artist_slug` is resolved as a
 * fallback here, through the same alias table the artist page uses, since a slug retired by the
 * accent-folding reslug (#410) is the other way a stored slug stops matching.
 *
 * `deleted = false` matters as much: `saved_artists` uses tombstones (migration 017), so without
 * it an artist you *unsaved* keeps feeding your calendar forever.
 */
async function savedArtistIdsForUser(
  client: NonNullable<ReturnType<typeof getClient>>,
  userId: string
): Promise<string[] | null> {
  const { data: saved, error: savedError } = await client
    .from('saved_artists')
    .select('artist_id, artist_slug, artist_name')
    .eq('user_id', userId)
    .eq('deleted', false);

  if (savedError) {
    console.error('[DB] savedArtistIdsForUser read failed:', savedError.message);
    return null;
  }

  const rows = (saved as { artist_id: string | null; artist_slug: string | null; artist_name: string | null }[]) || [];
  const ids = new Set<string>();
  const unresolved: { slug: string; name: string | null }[] = [];

  for (const row of rows) {
    if (row.artist_id) ids.add(row.artist_id);
    else if (row.artist_slug) unresolved.push({ slug: row.artist_slug.toLowerCase(), name: row.artist_name });
  }
  if (unresolved.length === 0) return [...ids];

  // Two candidates per row, because the stored slugs are two different kinds of wrong.
  //
  // The stored slug itself covers a *retired* slug (the accent-folding reslug, #410 — 44 aliases
  // exist), and is tried against the alias table below.
  //
  // `artistSlug(artist_name)` covers the synthetic search keys, which is what the rows actually
  // hold: measured on production, **not one** unlinked slug matched an artists row or an alias
  // directly — they are squashed names (`rodneyowl`, `seoulmetro`, `modelactriz`) and prefixed
  // platform keys (`qobuz-robertlogan`). Re-deriving from the name is the only thing that
  // recovers them, and it is the same expression `persistSearchResults` upserts the artist under,
  // so it names a row that exists rather than guessing at one.
  const candidates = new Set<string>();
  for (const row of unresolved) {
    candidates.add(row.slug);
    if (row.name) candidates.add(artistSlug(row.name));
  }

  // One `.in()` is safe without chunking here in a way it usually isn't: this is one person's
  // saved list, not a table scan. The PostgREST 1,000-row cap is nowhere near.
  const { data: bySlug, error: slugError } = await client
    .from('artists')
    .select('id, slug, name')
    .in('slug', [...candidates]);

  if (slugError) {
    // Reported rather than swallowed: returning the partial set would look exactly like "those
    // artists have nothing new", which is the confusion this whole function exists to stop. The
    // ids we did resolve are still returned — they are not in doubt.
    console.error('[DB] savedArtistIdsForUser slug resolution failed:', slugError.message);
    return [...ids];
  }

  const artistsBySlug = new Map<string, { id: string; name: string }>();
  for (const row of (bySlug as { id: string; slug: string; name: string }[]) || []) {
    artistsBySlug.set(row.slug.toLowerCase(), { id: row.id, name: row.name });
  }

  const stillUnmatched: string[] = [];
  for (const row of unresolved) {
    // An exact slug match is accepted outright — the saved row named this artist's page.
    const direct = artistsBySlug.get(row.slug);
    if (direct) {
      ids.add(direct.id);
      continue;
    }

    // A name-derived match has to prove itself, because a name is a much weaker key than a slug.
    // Requiring the found artist's own name to normalize identically stops a saved row with a
    // generic or wrong name ("Music") from silently adopting an unrelated artist's releases —
    // which would put someone else's record in a fan's calendar, a worse failure than showing
    // nothing.
    const derived = row.name ? artistSlug(row.name) : '';
    const byName = derived ? artistsBySlug.get(derived) : undefined;
    if (byName && artistSlug(byName.name) === derived) {
      ids.add(byName.id);
      continue;
    }

    stillUnmatched.push(row.slug);
  }

  if (stillUnmatched.length > 0) {
    const { data: aliased, error: aliasError } = await client
      .from('artist_slug_aliases')
      .select('artist_id, alias')
      .in('alias', stillUnmatched);

    if (aliasError) console.error('[DB] savedArtistIdsForUser alias resolution failed:', aliasError.message);
    else for (const row of (aliased as { artist_id: string }[]) || []) ids.add(row.artist_id);
  }

  return [...ids];
}

/** Slugs per artists lookup — keeps each response far below PostgREST's 1,000-row cap. */
const ARTIST_SLUG_LOOKUP_CHUNK = 100;

/**
 * The artists a fan owns a record by, resolved to artist ids.
 *
 * `collection_items` stores the artist as the source spelled it, not a foreign key, so this
 * resolves two ways: exactly, through a matched release's `artist_id`, and otherwise by
 * deriving the slug with `artistSlug()` — the same key every other writer uses. Around 72% of a
 * real import matches no release, so the slug path is the common one, not the fallback.
 * Artists that resolve neither way simply contribute nothing.
 *
 * A read failure returns an empty list rather than null: the collection is an *addition* to the
 * saved-artist feed, so failing here should quietly narrow the feed, never blank it.
 */
async function collectionArtistIdsForUser(
  client: NonNullable<ReturnType<typeof getClient>>,
  userId: string
): Promise<string[]> {
  const read = await readAllPages<{ artist_name: string | null; releases: { artist_id: string } | null }>(
    (from, to) =>
      client
        .from('collection_items')
        .select('artist_name, releases!left (artist_id)')
        .eq('user_id', userId)
        .range(from, to),
    'collection_items (feed)'
  );
  if (!read.ok) return [];

  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const row of read.rows) {
    if (row.releases?.artist_id) {
      ids.add(row.releases.artist_id);
      continue;
    }
    if (!row.artist_name) continue;
    const slug = artistSlug(row.artist_name);
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) return [...ids];

  // Chunked, unlike the saved-artist lookup above: a collection is a whole record library, not
  // a shortlist, so this one really can approach PostgREST's 1,000-row cap.
  const pending = [...slugs];
  for (let i = 0; i < pending.length; i += ARTIST_SLUG_LOOKUP_CHUNK) {
    const { data, error } = await client
      .from('artists')
      .select('id')
      .in('slug', pending.slice(i, i + ARTIST_SLUG_LOOKUP_CHUNK));
    if (error) {
      console.error('[DB] collectionArtistIdsForUser slug resolution failed:', error.message);
      break;
    }
    for (const row of (data as { id: string }[]) || []) ids.add(row.id);
  }

  return [...ids];
}

/**
 * Every release worth putting in one fan's feed: across their saved artists *and* the artists
 * in their collection, dated within the trailing window or still to come.
 *
 * Two exclusions match the alert path for the same reasons — hidden releases are suppressed by
 * an artist and must stay invisible, and a `needs_review` tier-3 fuzzy flag means we aren't sure
 * the release is distinct, which is not something to publish into someone's calendar.
 */
export async function getFeedReleasesForUser(userId: string, now: Date = new Date()): Promise<FeedReleaseRow[]> {
  const client = getClient();
  if (!client) return [];

  try {
    // Saved artists AND artists you own a record by. Buying somebody's album says at least as
    // much about wanting their next one as saving them does — but the two lists stay separate
    // everywhere else, because saving is deliberate and an import is not (spec OQ6, reversed
    // 2026-08-16). The Bandcamp import used to conscript matched artists into saved_artists,
    // which is what made their releases show up at all; this union is what keeps that promise
    // now that it doesn't.
    const savedIds = await savedArtistIdsForUser(client, userId);
    if (savedIds === null) return [];
    const collectionIds = await collectionArtistIdsForUser(client, userId);
    const artistIds = [...new Set([...savedIds, ...collectionIds])];
    if (artistIds.length === 0) return [];

    const { data, error } = await client
      .from('releases')
      .select(FEED_SELECT)
      .in('artist_id', artistIds)
      .eq('is_hidden', false)
      .eq('needs_review', false)
      .gte('release_date', feedSince(now))
      .order('release_date', { ascending: true })
      .limit(FEED_MAX_RELEASES);

    if (error) {
      console.error('[DB] getFeedReleasesForUser read failed:', error.message);
      return [];
    }

    return toFeedRows((data as unknown as FeedQueryRow[]) || []);
  } catch (error) {
    console.error('[DB] getFeedReleasesForUser error:', error);
    return [];
  }
}

/**
 * One artist's feed, for the public `/a/{slug}/releases.{xml,ics}`.
 *
 * **Deliberately unwindowed, unlike the per-fan and per-handle feeds above.** Those are a
 * calendar of what's coming across everything you follow, where a trailing window keeps the
 * thing usable. An artist feed is a different object: it is that artist's *discography*, and
 * someone subscribing to it wants the back catalogue, not just whatever happens to be imminent.
 * Brandon, on his own artist feed: *"It really should include everything - not just upcoming
 * ones."*
 *
 * Ordered newest-first rather than soonest-first, which is both the RSS convention and the safe
 * pairing with `FEED_MAX_RELEASES`: an ascending order plus a cap would silently drop an artist's
 * *recent* work in favour of their oldest.
 */
export async function getFeedReleasesForArtist(
  artistSlugValue: string,
  _now: Date = new Date()
): Promise<{ artistName: string; releases: FeedReleaseRow[] } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('id, name')
      .eq('slug', artistSlugValue)
      .maybeSingle();

    if (artistError || !artist) return null;
    const { id, name } = artist as { id: string; name: string };

    const { data, error } = await client
      .from('releases')
      .select(FEED_SELECT)
      .eq('artist_id', id)
      .eq('is_hidden', false)
      .eq('needs_review', false)
      // No date floor: the whole catalogue, past and upcoming. `not.is.null` because an undated
      // release has no event to place in a calendar and no meaningful position in a feed —
      // `toFeedRows` drops those anyway, so excluding them here stops them eating the cap.
      .not('release_date', 'is', null)
      .order('release_date', { ascending: false })
      .limit(FEED_MAX_RELEASES);

    if (error) {
      console.error('[DB] getFeedReleasesForArtist read failed:', error.message);
      return null;
    }

    return { artistName: name, releases: toFeedRows((data as unknown as FeedQueryRow[]) || []) };
  } catch (error) {
    console.error('[DB] getFeedReleasesForArtist error:', error);
    return null;
  }
}

/**
 * The public feed for a shared list at /u/{handle}.
 *
 * Gated on the same opt-in the HTML page uses (`usernames.saved_artists_public`) — a handle
 * existing is not consent to publish that person's subscriptions as a calendar. Returns null
 * when the handle is unknown *or* not shared, so the caller 404s either way and the feed can't
 * be used to probe which handles exist.
 */
export async function getFeedReleasesForHandle(
  handle: string,
  now: Date = new Date()
): Promise<{ displayName: string; releases: FeedReleaseRow[] } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data: row, error } = await client
      .from('usernames')
      .select('user_id, username, saved_artists_public')
      .eq('username', handle.toLowerCase())
      .maybeSingle();

    if (error || !row) return null;
    const username = row as { user_id: string; username: string; saved_artists_public: boolean };
    if (!username.saved_artists_public) return null;

    return {
      displayName: username.username,
      releases: await getFeedReleasesForUser(username.user_id, now),
    };
  } catch (error) {
    console.error('[DB] getFeedReleasesForHandle error:', error);
    return null;
  }
}
