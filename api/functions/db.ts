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

// --- Read Operations ---

/**
 * Look up an artist by slug. Returns null if not found or Supabase is not configured.
 */
export async function getArtistBySlug(slug: string): Promise<ArtistResult | null> {
  const client = getClient();
  if (!client) return null;

  try {
    // Try exact match first
    let { data: artist, error: artistError } = await client
      .from('artists')
      .select('*')
      .eq('slug', slug)
      .single();

    // If no exact match, try case-insensitive and hyphen-variant matches
    if (artistError || !artist) {
      // Try case-insensitive match (e.g. "KingTriumph" → "kingtriumph")
      const { data: ciData } = await client
        .from('artists')
        .select('*')
        .ilike('slug', slug)
        .single();
      if (ciData) {
        artist = ciData;
        artistError = null;
      }
    }

    // Try hyphenated variant (e.g. "king-triumph" → "kingtriumph")
    if ((artistError || !artist) && slug.includes('-')) {
      const noHyphens = slug.replace(/-/g, '');
      const { data: nhData } = await client
        .from('artists')
        .select('*')
        .eq('slug', noHyphens)
        .single();
      if (nhData) {
        artist = nhData;
        artistError = null;
      }
    }

    // Try adding hyphens at camelCase boundaries (e.g. "kingtriumph" → "king-triumph")
    if ((artistError || !artist) && !slug.includes('-')) {
      const hyphenated = slug.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      if (hyphenated !== slug) {
        const { data: hyData } = await client
          .from('artists')
          .select('*')
          .eq('slug', hyphenated)
          .single();
        if (hyData) {
          artist = hyData;
          artistError = null;
        }
      }
    }

    if (artistError || !artist) return null;

    const row = artist as ArtistRow;

    // Claimed artists are always fresh; auto-discovered artists expire
    if (row.match_confidence !== 'claimed') {
      const updatedAt = new Date(row.updated_at).getTime();
      const now = Date.now();
      if (now - updatedAt > FRESHNESS_TTL_MS) {
        return null; // Stale, caller should refresh
      }
    }

    const { data: links, error: linksError } = await client
      .from('artist_links')
      .select('*')
      .eq('artist_id', row.id)
      .order('display_order', { ascending: true, nullsFirst: false });

    if (linksError) return null;

    const platforms: PlatformLink[] = (links as LinkRow[]).map(link => ({
      sourceId: link.platform,
      url: link.url,
      ...(link.display_name ? { displayName: link.display_name } : {}),
      ...(link.latest_release ? { latestRelease: link.latest_release as PlatformLink['latestRelease'] } : {}),
    }));

    // Fetch profile data for claimed artists
    let profile: ArtistProfile | undefined;
    if (row.match_confidence === 'claimed') {
      const { data: profileData } = await client
        .from('artist_profiles')
        .select('bio, custom_image_url, website_url, featured_embed, verified_at')
        .eq('artist_id', row.id)
        .single();

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
export async function persistSearchResults(results: ArtistResult[]): Promise<void> {
  const client = getClient();
  if (!client) return;

  for (const result of results) {
    if (result.type !== 'artist') continue;

    // Filter out excluded platforms and non-direct links
    const validPlatforms = result.platforms.filter(
      p => !EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url)
    );

    // Only persist artists with at least 1 real direct link
    if (validPlatforms.length === 0) continue;

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
        continue;
      }

      // Upsert artist — always store as unverified until claimed
      const { data: artist, error: artistError } = await client
        .from('artists')
        .upsert(
          {
            slug,
            name: result.name,
            image_url: result.imageUrl || null,
            match_confidence: 'unverified',
            source: 'auto',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'slug' }
        )
        .select('id')
        .single();

      if (artistError || !artist) {
        console.error(`[DB] Failed to upsert artist "${result.name}":`, artistError);
        continue;
      }

      const artistId = artist.id;

      // Upsert links (only valid platforms)
      const linkRows = validPlatforms.map((platform, index) => ({
        artist_id: artistId,
        platform: platform.sourceId,
        url: platform.url,
        source: 'search',
        is_direct: true,
        latest_release: platform.latestRelease || null,
        display_order: index,
      }));

      for (const row of linkRows) {
        const { error: linkError } = await client
          .from('artist_links')
          .upsert(row, { onConflict: 'artist_id,platform' });

        if (linkError) {
          console.error(`[DB] Failed to upsert link ${row.platform} for "${result.name}":`, linkError);
        }
      }

      console.log(`[DB] Persisted "${result.name}" with ${linkRows.length} links`);
    } catch (error) {
      console.error(`[DB] Error persisting "${result.name}":`, error);
    }
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
