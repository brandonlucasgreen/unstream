// Supabase database module for the Unstream artist database.
// All operations are optional — if Supabase is not configured, they no-op gracefully.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
        .select('bio, custom_image_url, featured_embed, verified_at')
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
            .select('bio, custom_image_url, website_url, featured_embed, verified_at')
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

/**
 * Persist artist search results to the database.
 * Only persists artist-type results. Runs as fire-and-forget after search.
 */
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

export async function persistSearchResults(results: ArtistResult[]): Promise<void> {
  const client = getClient();
  if (!client) return;

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
