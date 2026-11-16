// Reading artists: a profile or a stored card by slug, retired-slug aliases, typeahead
// suggestions and lookups by name.

import { artistSlug } from '../../shared/artist-slug';
import { GUESSED_SLUG_CANDIDATE_LIMIT, nameGuessPattern, pickArtistForGuessedSlug } from '../../shared/guessed-slug';
import { getClient } from './client';

// artistSlug lives in api/shared/artist-slug.ts so the web client (claim links) computes the same
// slug; re-exported here for the many server importers.
export { artistSlug };

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
  // False when the artist turned bios off — search then shows none, not a third party's.
  showBio: boolean;
  customImageUrl?: string;
  websiteUrl?: string;
  featuredEmbed?: string;
  verified: boolean;
  // Divider positions in the artist's link order — see api/shared/link-dividers.ts.
  // Carried here so the artist edit page can rebuild the arrangement it saved.
  linkDividers?: number[];
  // UNS-221: the saved page-section arrangement, for the edit page's reorder control.
  // Renderers normalize (unknown keys dropped, omissions re-appended) — this is the raw value.
  sectionOrder?: string[];
}

interface ArtistResult {
  id: string;
  // The artist's canonical stored slug. Cards must link with this, never a slug
  // derived from a search query — getArtistBySlug matches tolerantly (e.g. query
  // "me:she" → slug "me-she" matches stored slug "meshe"), so only this value is
  // guaranteed to resolve at /a/<slug>.
  slug: string;
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
  // Artist-arranged page-section order (UNS-221, api/shared/page-sections.ts).
  // NULL = unsaved/default; unknown keys filtered at read time by normalizeSectionOrder.
  section_order: string[] | null;
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
    // The artist row, its profile and its links in ONE round trip, embedded. This used to be two
    // sequential trips (the row, then profile and links in parallel), on the critical path of
    // every uncached artist page. `artist_profiles.artist_id` is UNIQUE, so PostgREST embeds the
    // profile as an object (or null), never an array.
    //
    // maybeSingle() rather than single(): single() reports "0 rows" as an error, which is what made
    // a genuine absence indistinguishable from a real failure.
    const { data, error } = await client
      .from('artists')
      .select(
        '*, artist_profiles ( bio, custom_image_url, featured_embed, verified_at, link_dividers, section_order ),' +
        ' artist_links ( * )'
      )
      .eq('slug', slug)
      .order('display_order', { referencedTable: 'artist_links', ascending: true, nullsFirst: false })
      .maybeSingle();

    if (error) return { bundle: null, failed: true };
    if (!data) return { bundle: null, failed: false };

    // Deliberately no `match_confidence === 'claimed'` filter. Unclaimed artists have a real row
    // and real links, and /artist/:slug renders them as the quiet card — the same page the
    // artist-page-static edge function serves crawlers, which has never had this filter either.
    // Gating here 404'd every unclaimed artist page for anyone running JS (see #369).
    //
    // The embeds are split back off so `artist` stays the plain row every caller expects.
    const { artist_profiles: profile, artist_links: links, ...artistRow } = data as unknown as ArtistRow & {
      artist_profiles: ArtistProfileRow | null;
      artist_links: LinkRow[] | null;
    };

    return {
      bundle: {
        artist: artistRow,
        profile: profile ?? null,
        links: links || [],
      },
      failed: false,
    };
  } catch (error) {
    console.error('[DB] getArtistProfileBySlug error:', error);
    return { bundle: null, failed: true };
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
 *
 * A slug that isn't an alias gets one more chance: if it is exactly one artist's name slugified,
 * that artist is the canonical (`/a/impulse-nine` -> `impulsenine`). See api/shared/guessed-slug.ts.
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
    if (target) return { canonical: target, failed: false };

    const pattern = nameGuessPattern(slug);
    if (!pattern) return { canonical: null, failed: false };
    const { data: candidates, error: guessError } = await client
      .from('artists')
      .select('slug, name')
      .ilike('name', pattern)
      .limit(GUESSED_SLUG_CANDIDATE_LIMIT);
    if (guessError) {
      console.error('[DB] Failed to resolve guessed artist slug:', guessError.message);
      return { canonical: null, failed: true };
    }
    return { canonical: pickArtistForGuessedSlug(slug, candidates ?? []), failed: false };
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
  // can't match a real artist, so it is rejected here without a query.
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return null;

  try {
    // The lookup tolerates three slug variants, checked in priority order:
    //   1. exact match, 2. case-insensitive (e.g. "KingTriumph"),
    //   3. hyphens stripped ("king-triumph" → "kingtriumph"),
    //   4. hyphens added at camelCase boundaries ("kingTriumph" → "king-triumph").
    // They're fetched in ONE query — the old one-query-per-variant fallback
    // chain cost up to 4 sequential round-trips on every miss, and this
    // function runs at the front of every search.
    //
    // Case-insensitivity comes from lowercasing the input, not from `ilike`: every writer of
    // `artists.slug` lowercases it (artistSlug, slugify in artist-profile.ts, the manifest), so
    // the lowercase variant finds what `ilike` found. `ilike` can't use the slug's unique index,
    // so it made this query a sequential scan of `artists` on every search; `in` is an index
    // lookup. The exact input stays in the list for a stored slug that predates that rule.
    const lowerSlug = slug.toLowerCase();
    const noHyphens = slug.includes('-') ? lowerSlug.replace(/-/g, '') : null;
    const camelHyphenated = !slug.includes('-')
      ? slug.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
      : null;

    const variants = new Set([slug, lowerSlug]);
    if (noHyphens) variants.add(noHyphens);
    if (camelHyphenated) variants.add(camelHyphenated);

    const { data: candidates, error: artistError } = await client
      .from('artists')
      .select('*')
      .in('slug', [...variants]);

    if (artistError || !candidates || candidates.length === 0) return null;

    const rows = candidates as ArtistRow[];
    const artist =
      rows.find(r => r.slug === slug) ||
      rows.find(r => r.slug === lowerSlug) ||
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
            .select('bio, show_bio, custom_image_url, website_url, featured_embed, verified_at, link_dividers, section_order')
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
  show_bio: boolean | null;
  custom_image_url: string | null;
  website_url: string | null;
  featured_embed: string | null;
  verified_at: string | null;
  link_dividers: number[] | null;
  section_order: string[] | null;
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
      // `!== false`: absent (a pre-migration read) means the default, on.
      showBio: profileData.show_bio !== false,
      customImageUrl: profileData.custom_image_url || undefined,
      websiteUrl: profileData.website_url || undefined,
      featuredEmbed: profileData.featured_embed || undefined,
      verified: !!profileData.verified_at,
      ...(profileData.link_dividers?.length ? { linkDividers: profileData.link_dividers } : {}),
      ...(profileData.section_order?.length ? { sectionOrder: profileData.section_order } : {}),
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
    slug: row.slug,
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
            .select('artist_id, bio, show_bio, custom_image_url, website_url, featured_embed, verified_at, link_dividers')
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
/**
 * Slugs of claimed artists whose name is exactly the term, ignoring case.
 *
 * A claimed profile is usually found at the slug of its name, but artists who share a name are
 * stored at addresses that tell them apart (`xparacosm`, `paracosm-orlando`; see recordSlugs), so a
 * detection of "Paracosm" playing must look them up by name too. Exact, not contains: a detection
 * query IS the artist's name.
 */
export async function findClaimedArtistSlugsByExactName(name: string): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  // Escape ILIKE's wildcards so the match is equality, ignoring case.
  const cleaned = name.trim().replace(/[\\%_]/g, m => `\\${m}`);
  if (cleaned.length < 2) return [];

  const { data, error } = await client
    .from('artists')
    .select('slug')
    .ilike('name', cleaned)
    .eq('match_confidence', 'claimed')
    .limit(10);

  if (error) {
    console.error('[DB] findClaimedArtistSlugsByExactName error:', error);
    return [];
  }
  return (data ?? []).map(row => row.slug as string);
}

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
