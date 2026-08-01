// Supabase database module for the Unstream artist database.
// All operations are optional — if Supabase is not configured, they no-op gracefully.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeUrlForMatch, urlMatchPrefilter } from './search-utils';
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

// Determine if a platform URL is a direct link (not a search URL)
function isDirectLink(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.includes('duckduckgo.com') &&
    !lower.includes('google.com/search') &&
    !lower.includes('searchstyle=search') &&
    !lower.includes('explore-creators')
  );
}

// Platforms that are manual search links, not real artist presences
const EXCLUDED_PLATFORMS = new Set(['buymeacoffee', 'kofi', 'ampwall']);

// How long before artist data is considered stale (24 hours)
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

// --- Types matching the search-sources response ---

interface PlatformLink {
  sourceId: string;
  url: string;
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
 * Fetch the artist row + profile row + links for a claimed artist.
 * Returns null if the artist doesn't exist or isn't claimed.
 */
export async function getArtistProfileBySlug(slug: string): Promise<ArtistProfileBundle | null> {
  const client = getClient();
  if (!client) return null;

  try {
    // Find the artist row first
    const { data: artist, error: artistError } = await client
      .from('artists')
      .select('*')
      .eq('slug', slug)
      .single();

    if (artistError || !artist) return null;
    if (artist.match_confidence !== 'claimed') return null;

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
      artist: artistRow,
      profile: (profileResult.data as ArtistProfileRow | null) ?? null,
      links: (linksResult.data as LinkRow[]) || [],
    };
  } catch (error) {
    console.error('[DB] getArtistProfileBySlug error:', error);
    return null;
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

      // detail_checked_at is read back rather than written: it belongs to the detail pass, and
      // a grid re-crawl must not reset it or every crawl would re-fetch every release page.
      const { data: sourceRow, error: sourceError } = await client
        .from('release_sources')
        .upsert(
          {
            release_id: releaseId,
            platform: release.source.platform,
            url: release.source.url,
            external_id: release.source.externalId,
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: 'release_id,platform' }
        )
        .select('id, url, detail_checked_at')
        .single();

      if (sourceError || !sourceRow) {
        console.error('[DB] persistReleases source upsert failed:', sourceError?.message);
        continue;
      }

      const source = sourceRow as { id: string; url: string; detail_checked_at: string | null };
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
  status: string;
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
    if (!release.curatedFields.includes('release_date')) {
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

/** The stored Bandcamp link for an artist, if we have one. */
export async function getArtistBandcampUrl(artistId: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('artist_links')
      .select('url')
      .eq('artist_id', artistId)
      .eq('platform', 'bandcamp')
      .maybeSingle();

    if (error) {
      console.error('[DB] getArtistBandcampUrl failed:', error.message);
      return null;
    }
    return (data as { url: string } | null)?.url ?? null;
  } catch (error) {
    console.error('[DB] getArtistBandcampUrl error:', error);
    return null;
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
  offers: { price: number | null; currency: string | null; availability: string }[];
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
        ' release_sources ( release_offers ( price, currency, availability ) )',
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
      release_sources: { release_offers: { price: number | null; currency: string | null; availability: string }[] | null }[] | null;
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
      offers: (r.release_sources || []).flatMap(s => s.release_offers || []),
    }));

    return { releases, total: count ?? releases.length };
  } catch (error) {
    console.error('[DB] getArtistReleases error:', error);
    return { releases: [], total: 0 };
  }
}
