// Supabase database module for the Unstream artist database.
// All operations are optional — if Supabase is not configured, they no-op gracefully.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeUrlForMatch, urlMatchPrefilter } from './search-utils';
import {
  deriveStatus,
  isFuzzyReleaseMatch,
  mapReleaseType,
  parseReleaseDate,
  releaseMatchKey,
  uniqueReleaseSlug,
} from './release-utils';
import { requestArtistCatalog } from './request-catalog';

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

// Generate a URL-safe slug from an artist name
export function artistSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Determine if a platform URL is a direct link (not a search URL).
// Exported so scripts/backfill-published-artist-rows.ts stores exactly what a search would store.
export function isDirectLink(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.includes('duckduckgo.com') &&
    !lower.includes('google.com/search') &&
    !lower.includes('searchstyle=search') &&
    !lower.includes('explore-creators')
  );
}

// Platforms that are manual search links, not real artist presences.
// Exported alongside isDirectLink for the same reason — see above.
export const EXCLUDED_PLATFORMS = new Set(['buymeacoffee', 'kofi', 'ampwall']);

// How long before artist data is considered stale (24 hours)
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

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

export async function getMergeOverrides(): Promise<MergeOverrideRow[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('artist_merge_overrides')
      .select('id, group_name, platform_urls, excluded_urls, canonical_image_url');

    if (error) {
      console.error('[DB] Failed to fetch merge overrides:', error);
      return [];
    }

    return (data as MergeOverrideRow[]) || [];
  } catch (error) {
    console.error('[DB] getMergeOverrides error:', error);
    return [];
  }
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
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('platform_link_suppressions')
      .select('url, artist_name_norm');

    if (error) {
      console.error('[DB] Failed to fetch link suppressions:', error);
      return [];
    }

    return (data as Pick<LinkSuppressionRow, 'url' | 'artist_name_norm'>[]) || [];
  } catch (error) {
    console.error('[DB] getLinkSuppressions error:', error);
    return [];
  }
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
const RECATALOG_COOLDOWN_HOURS = 24 * 7;

/**
 * Hourly ceilings on how many artists we will catalog, by what triggered it.
 *
 * Search is unauthenticated and far higher volume than saving, so it gets the smaller
 * budget: a traffic spike must not turn into us hammering Bandcamp. A save is one person
 * deliberately asking to follow an artist, so it gets a bigger budget and still gets through
 * when searches are being dropped.
 */
const CATALOG_HOURLY_CAP = { searched: 60, saved: 240 } as const;

export type CatalogTrigger = 'saved' | 'searched';

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
 * 1. **Match on `(artist_id, release_type, match_key)`, not on slug.** A slug is derived from
 *    a title and changes when the title does; the match key is what identity means here.
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
async function getClaimedSourceKeys(client: SupabaseClient, releaseIds: string[]): Promise<Set<string>> {
  if (releaseIds.length === 0) return new Set();

  const { data, error } = await client
    .from('release_sources')
    .select('release_id, platform')
    .eq('source', 'claimed')
    .in('release_id', releaseIds);

  if (error) {
    console.error('[DB] getClaimedSourceKeys failed:', error.message);
    return new Set();
  }

  return new Set((data as { release_id: string; platform: string }[] || []).map(r => `${r.release_id}:${r.platform}`));
}

/**
 * Write one release's source row — or, if an artist has claimed this exact release+platform,
 * read the existing (untouched) row back instead. The one place every ingest path goes through
 * to write `release_sources`, so "never overwrite a claimed URL" only has to be correct once.
 */
async function upsertReleaseSource(
  client: SupabaseClient,
  releaseId: string,
  platform: string,
  url: string,
  externalId: string | null,
  claimedKeys: Set<string>
): Promise<{ id: string; url: string; detail_checked_at: string | null } | null> {
  if (claimedKeys.has(`${releaseId}:${platform}`)) {
    const { data, error } = await client
      .from('release_sources')
      .select('id, url, detail_checked_at')
      .eq('release_id', releaseId)
      .eq('platform', platform)
      .maybeSingle();
    if (error || !data) return null;
    return data as { id: string; url: string; detail_checked_at: string | null };
  }

  // detail_checked_at is read back rather than written: it belongs to the detail pass, and a
  // grid re-crawl must not reset it or every crawl would re-fetch every release page.
  const { data, error } = await client
    .from('release_sources')
    .upsert(
      { release_id: releaseId, platform, url, external_id: externalId, last_seen_at: new Date().toISOString() },
      { onConflict: 'release_id,platform' }
    )
    .select('id, url, detail_checked_at')
    .single();

  if (error || !data) return null;
  return data as { id: string; url: string; detail_checked_at: string | null };
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
      .select('id, slug, match_key, release_type, release_date, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byIdentity = new Map(existing.map(r => [`${r.release_type}:${r.match_key}`, r]));
    const takenSlugs = new Set(existing.map(r => r.slug));
    const claimedKeys = await getClaimedSourceKeys(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const identity = `${release.releaseType}:${release.matchKey}`;
      const prior = byIdentity.get(identity);
      const curated = new Set(prior?.curated_fields ?? []);

      let releaseId: string;

      if (prior) {
        const patch: Record<string, unknown> = {};
        // COALESCE semantics, applied in JS: only fill what's missing, never blank what's set,
        // and never touch what the artist edited.
        if (!curated.has('title')) patch.title = release.title;
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
        byIdentity.set(identity, {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
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
        claimedKeys
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

      const { error } = await client.from('releases').update(patch).eq('id', release.releaseId);
      if (error) {
        console.error('[DB] persistReleaseDetail release update failed:', error.message);
        return false;
      }
    }

    if (detail.offers.length > 0) {
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
        .in('platform', ['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'officialsite']),
    ]);

    if (artistError || !artistRow) {
      if (artistError) console.error('[DB] getArtistForCatalog artist read failed:', artistError.message);
      return null;
    }
    if (linkError) console.error('[DB] getArtistForCatalog link read failed:', linkError.message);

    const links = (linkRows as { platform: string; url: string }[] | null) || [];
    return {
      name: (artistRow as { name: string }).name,
      bandcampUrl: links.find(l => l.platform === 'bandcamp')?.url ?? null,
      discogsUrl: links.find(l => l.platform === 'discogs')?.url ?? null,
      faircampUrl: links.find(l => l.platform === 'faircamp')?.url ?? null,
      jamcoopUrl: links.find(l => l.platform === 'jamcoop')?.url ?? null,
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
 *    Only fall back to `(release_type, match_key)` — tier 2 — when this artist has no row
 *    with that master id yet, and only when that tier-2 candidate doesn't already carry a
 *    *different* master id (which would mean the title match is coincidental, not the same
 *    release). And when nothing matches exactly but a title is merely *close* to an existing
 *    one — `isFuzzyReleaseMatch` — this never merges either: it inserts a new row and flags
 *    both `needs_review`, which is tier 3. A human decides; the catalog never silently
 *    asserts two different albums are the same one.
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
      .select('id, slug, match_key, release_type, release_date, curated_fields, discogs_master_id')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistDiscogsReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      curated_fields: string[] | null;
      discogs_master_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMasterId = new Map(
      existing.filter(r => r.discogs_master_id).map(r => [r.discogs_master_id as string, r])
    );
    const byIdentity = new Map(existing.map(r => [`${r.release_type}:${r.match_key}`, r]));
    const byType = new Map<string, ExistingRow[]>();
    for (const row of existing) {
      const bucket = byType.get(row.release_type);
      if (bucket) bucket.push(row);
      else byType.set(row.release_type, [row]);
    }
    const takenSlugs = new Set(existing.map(r => r.slug));
    const claimedKeys = await getClaimedSourceKeys(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      let prior = byMasterId.get(release.masterId);
      let matchedByMasterId = Boolean(prior);

      if (!prior) {
        const exact = byIdentity.get(`${release.releaseType}:${release.matchKey}`);
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
        : (byType.get(release.releaseType) ?? []).find(c => isFuzzyReleaseMatch(c.match_key, release.matchKey)) ?? null;

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
        if (!curated.has('title') && matchedByMasterId) patch.title = release.title;
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
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          curated_fields: [],
          discogs_master_id: release.masterId,
        };
        byMasterId.set(release.masterId, createdRow);
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
        claimedKeys
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
 * (`release_type` + `match_key`) — and only when that tier-2 candidate doesn't already carry
 * a *different* MBID, which would mean the title match is coincidental. Returns how many rows
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
      .select('id, match_key, release_type, release_date, curated_fields, musicbrainz_release_group_id')
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
      curated_fields: string[] | null;
      musicbrainz_release_group_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMbid = new Map(
      existing.filter(r => r.musicbrainz_release_group_id).map(r => [r.musicbrainz_release_group_id as string, r])
    );
    const byIdentity = new Map(existing.map(r => [`${r.release_type}:${r.match_key}`, r]));

    let touched = 0;

    for (const group of groups) {
      let row = byMbid.get(group.mbid);
      if (!row) {
        const candidate = byIdentity.get(`${group.releaseType}:${group.matchKey}`);
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
 * Matches on `match_key` **alone**, not `(release_type, match_key)` like every other source —
 * Faircamp's own release-type guess (`mapDiscogsFormatToReleaseType` reading just a title) is
 * unreliable enough that partitioning by it would systematically block the one thing that
 * makes Faircamp worth ingesting: merging into a release Bandcamp or Discogs already typed
 * correctly, adding Faircamp as a second source on the *same* row instead of a duplicate. When
 * nothing matches exactly, a title merely *close* to an existing one still only ever flags
 * (tier 3, `isFuzzyReleaseMatch`) — never merges — same as Discogs.
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
    const byMatchKey = new Map(existing.map(r => [r.match_key, r]));
    const takenSlugs = new Set(existing.map(r => r.slug));
    const claimedKeys = await getClaimedSourceKeys(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const prior = byMatchKey.get(release.matchKey);

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
        const fuzzy = existing.find(c => isFuzzyReleaseMatch(c.match_key, release.matchKey));

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
        byMatchKey.set(release.matchKey, createdRow);
        existing.push(createdRow);

        if (fuzzy) {
          const { error: flagError } = await client
            .from('releases')
            .update({ needs_review: true, flagged_against_release_id: releaseId })
            .eq('id', fuzzy.id);
          if (flagError) console.error('[DB] persistFaircampReleases fuzzy-flag failed:', flagError.message);
        }
      }

      const source = await upsertReleaseSource(client, releaseId, 'faircamp', release.externalUrl, release.externalUrl, claimedKeys);
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
      .select('id, slug, match_key, release_type, release_date, artwork_url, curated_fields')
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
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMatchKey = new Map(existing.map(r => [r.match_key, r]));
    const takenSlugs = new Set(existing.map(r => r.slug));
    const claimedKeys = await getClaimedSourceKeys(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];

    for (const release of releases) {
      const prior = byMatchKey.get(release.matchKey);

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
        const fuzzy = existing.find(c => isFuzzyReleaseMatch(c.match_key, release.matchKey));

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
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        byMatchKey.set(release.matchKey, createdRow);
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
        claimedKeys
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
        platforms: (r.release_sources || []).map(s => s.platform),
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
 * Refuses the merge outright if both releases already carry a source on the same platform,
 * rather than silently dropping one — a merge with an ambiguous outcome should stop and ask,
 * not guess which of two conflicting sources to keep.
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
      client.from('release_sources').select('platform').eq('release_id', keepId),
      client.from('release_sources').select('id, platform').eq('release_id', dropId),
    ]);

    if (keepError || dropError) {
      console.error('[DB] mergeReleases read failed:', keepError?.message, dropError?.message);
      return { ok: false, error: 'Failed to read sources' };
    }

    const keepPlatforms = new Set((keepSources as { platform: string }[] | null || []).map(s => s.platform));
    const drop = (dropSources as { id: string; platform: string }[] | null) || [];
    const conflicting = drop.filter(s => keepPlatforms.has(s.platform));

    if (conflicting.length > 0) {
      const platforms = conflicting.map(c => c.platform).join(', ');
      return { ok: false, error: `Both releases already have a source on: ${platforms} — resolve manually` };
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

    const [{ data: keepRow }, { data: dropRow }] = await Promise.all([
      client.from('releases').select('release_date, artwork_url, curated_fields').eq('id', keepId).maybeSingle(),
      client.from('releases').select('release_date, date_precision, artwork_url').eq('id', dropId).maybeSingle(),
    ]);

    if (keepRow && dropRow) {
      const curated = new Set((keepRow as { curated_fields: string[] | null }).curated_fields ?? []);
      const patch: Record<string, unknown> = {};
      const keep = keepRow as { release_date: string | null; artwork_url: string | null };
      const drop2 = dropRow as { release_date: string | null; date_precision: string | null; artwork_url: string | null };

      if (!curated.has('release_date') && drop2.release_date && !keep.release_date) {
        patch.release_date = drop2.release_date;
        patch.date_precision = drop2.date_precision;
      }
      if (!curated.has('artwork_url') && drop2.artwork_url && !keep.artwork_url) {
        patch.artwork_url = drop2.artwork_url;
      }
      if (Object.keys(patch).length > 0) {
        await client.from('releases').update(patch).eq('id', keepId);
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
      .update({ needs_review: false, flagged_against_release_id: null })
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
  sources: { platform: string; url: string }[];
}

/**
 * Every release under this artist — including hidden ones and needs_review ones, unlike the
 * public `getArtistReleases`, because the whole point of this view is letting the artist see
 * what ingest did (right or wrong) rather than only what a fan would see.
 */
export async function getArtistReleasesForOwner(artistId: string): Promise<OwnerReleaseItem[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('releases')
      .select(
        'id, title, slug, release_type, release_date, date_precision, artwork_url, is_hidden,' +
        ' needs_review, flagged_against_release_id, release_sources ( platform, url )'
      )
      .eq('artist_id', artistId)
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
      sources: (r.release_sources || []).map(s => ({ platform: s.platform, url: s.url })),
    }));
  } catch (error) {
    console.error('[DB] getArtistReleasesForOwner error:', error);
    return [];
  }
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
 * `source: 'claimed'`, which `getClaimedSourceKeys` (used by every ingest path) checks before
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

  // `external_id` is deliberately absent, not null. PostgREST's upsert updates only the columns
  // present in the payload, so leaving it out keeps whatever id ingest already stored for this
  // platform — writing an explicit null would erase the one thing that makes a re-crawl
  // idempotent, and the next crawl would mint a duplicate source rather than update this row.
  const { error } = await client.from('release_sources').upsert(
    {
      release_id: releaseId,
      platform,
      url,
      source: 'claimed',
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'release_id,platform' }
  );

  if (error) {
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
      console.log(`[DB] Re-probing "${queryNorm}": cached negative covered ${JSON.stringify(row.probed_slugs)}, query needs ${JSON.stringify(candidates)}`);
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

    const platforms: PlatformLink[] = (links as LinkRow[]).map(link => ({
      sourceId: link.platform,
      url: link.url,
      ...(link.display_name ? { displayName: link.display_name } : {}),
      ...(link.latest_release ? { latestRelease: link.latest_release as PlatformLink['latestRelease'] } : {}),
    }));

    let profile: ArtistProfile | undefined;
    if (row.match_confidence === 'claimed') {
      if (profileData) {
        profile = {
          bio: profileData.bio || undefined,
          customImageUrl: profileData.custom_image_url || undefined,
          websiteUrl: profileData.website_url || undefined,
          featuredEmbed: profileData.featured_embed || undefined,
          verified: !!profileData.verified_at,
          ...(profileData.link_dividers?.length ? { linkDividers: profileData.link_dividers } : {}),
        };
      }
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
  } catch (error) {
    console.error('[DB] getArtistBySlug error:', error);
    return null;
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
 * Persist artist search results to the database.
 * Only persists artist-type results. Runs as fire-and-forget after search.
 */
export async function persistSearchResults(results: ArtistResult[]): Promise<void> {
  const client = getClient();
  if (!client) return;

  // Artists persisted in this run that have a Bandcamp link, collected so cataloging can be
  // requested in a single call afterwards rather than once per artist. This function is
  // awaited before the search response is sent, so wall-clock time here is user-visible.
  const catalogCandidates: string[] = [];

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

    const slug = artistSlug(result.name);

    try {
      // Check if this artist is already claimed — never overwrite claimed status
      const { data: existing } = await client
        .from('artists')
        .select('id, match_confidence')
        .eq('slug', slug)
        .single();

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
      const { data: artist, error: artistError } = await client
        .from('artists')
        .upsert(
          {
            slug,
            name: result.name,
            image_url: result.imageUrl || null,
            match_confidence: result.matchConfidence === 'verified' ? 'verified' : 'unverified',
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

      const artistId = artist.id;

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

      const { error: linkError } = await client
        .from('artist_links')
        .upsert(linkRows, { onConflict: 'artist_id,platform' });

      if (linkError) {
        console.error(`[DB] Failed to upsert links for "${result.name}":`, linkError);
      }

      console.log(`[DB] Persisted "${result.name}" with ${linkRows.length} links`);

      // Only worth cataloging artists we can actually catalog — ingest is Bandcamp-only for
      // now, so an artist without a Bandcamp link would just be a wasted claim.
      if (linkRowsByPlatform.has('bandcamp')) catalogCandidates.push(artistId);
    } catch (error) {
      console.error(`[DB] Error persisting "${result.name}":`, error);
    }
  }));

  // One request for the whole result set, after the writes, and only a 202 handshake is
  // awaited. Cooldown and rate-cap checks happen inside the background function, so a search
  // never pays a database round trip per artist to find out an artist was crawled last week.
  if (catalogCandidates.length > 0) {
    await requestArtistCatalog(catalogCandidates, 'searched');
  }
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
      console.log(`[DB] Skipping enrichment for claimed artist "${artistName}"`);
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
    console.log(`[DB] Enriched "${artistName}" with ${enrichmentLinks.length} MusicBrainz links${locationLog}`);
  } catch (error) {
    console.error(`[DB] Error enriching "${artistName}":`, error);
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
 * An artist's releases for their page, newest first, plus the total.
 *
 * `count: 'exact'` rides along with the limit in one round trip, so an "and N more" line is a
 * real number rather than a guess. Ordering matches idx_releases_artist_chrono: many releases
 * have no date yet — grid ingest gets identity and artwork but no dates — and without the
 * created_at tiebreaker those undated rows would shuffle between requests.
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

type FeedQueryRow = {
  slug: string;
  title: string;
  release_date: string | null;
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
  'slug, title, release_date, artwork_url, artists!inner ( name, slug ),' +
  ' release_sources ( platform, url, release_offers ( price, currency, availability ) )';

/** Soonest first — a calendar and a reader both want the next thing at the top. */
function feedSince(now: Date): string {
  return new Date(now.getTime() - FEED_TRAILING_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every release worth putting in one fan's feed: across all their saved artists, dated within
 * the trailing window or still to come.
 *
 * Two exclusions match the alert path for the same reasons — hidden releases are suppressed by
 * an artist and must stay invisible, and a `needs_review` tier-3 fuzzy flag means we aren't sure
 * the release is distinct, which is not something to publish into someone's calendar.
 */
export async function getFeedReleasesForUser(userId: string, now: Date = new Date()): Promise<FeedReleaseRow[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data: saved, error: savedError } = await client
      .from('saved_artists')
      .select('artist_id')
      .eq('user_id', userId);

    if (savedError) {
      console.error('[DB] getFeedReleasesForUser saved read failed:', savedError.message);
      return [];
    }

    const artistIds = ((saved as { artist_id: string }[]) || []).map(r => r.artist_id);
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
