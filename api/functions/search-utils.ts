// Pure utility functions and types extracted from search-sources.ts
// No HTTP, cache, or database dependencies.

export type SourceId =
  | 'bandcamp'
  | 'mirlo'
  | 'nina'
  | 'ampwall'
  | 'artcore'
  | 'bandwagon'
  | 'faircamp'
  | 'jamcoop'
  | 'patreon'
  | 'buymeacoffee'
  | 'kofi'
  | 'qobuz'
  | 'beatport'
  | 'even'
  | 'officialsite'
  | 'discogs'
  | 'hoopla'
  | 'freegal'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'youtube'
  | 'threads'
  | 'bluesky'
  | 'mastodon'
  | 'peertube'
  | 'other';

export interface LatestRelease {
  title: string;
  type: 'album' | 'track';
  url: string;
  imageUrl?: string;
  releaseDate?: string; // ISO date or human-readable date string
}

export interface PlatformResult {
  sourceId: SourceId;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  url: string;
  imageUrl?: string;
  latestRelease?: LatestRelease;
  // Normalized release titles, when the source already had them in hand. Lets
  // fetchReleasesForDisambiguation skip a refetch — that step shares one 4s budget
  // across platforms, so a redundant request costs another platform its data.
  allReleaseTitles?: string[];
}

export interface AggregatedResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: {
    sourceId: SourceId;
    url: string;
    displayName?: string;
    latestRelease?: LatestRelease;
    allReleaseTitles?: string[]; // For disambiguation - all release titles (normalized)
  }[];
  // Match confidence: 'verified' means releases match across platforms,
  // 'unverified' means name-only match (no release data to compare)
  // 'claimed' means artist has verified ownership of this profile
  matchConfidence?: 'verified' | 'unverified' | 'claimed';
  // Slug for claimed artist page (/a/{slug})
  claimedSlug?: string;
  // Set to true when this result was merged via a manual override — protects it from later splitting
  overrideMerged?: boolean;
  // Artist location — populated from the DB for claimed artists and from
  // Phase 2 MusicBrainz/Bandcamp/Mirlo enrichment for unclaimed artists.
  location?: {
    city?: string;
    country?: string;
    countryCode?: string;
  };
  wikipediaSummary?: string;
  wikipediaUrl?: string;
}

export interface SearchResponse {
  query: string;
  results: AggregatedResult[];
  hasPendingEnrichment?: boolean;
}

export interface MergeOverride {
  id: string;
  group_name: string;
  platform_urls: string[];
  excluded_urls: string[];
  canonical_image_url: string | null;
}

// Infer sourceId from a platform URL
export function sourceIdFromUrl(url: string): SourceId | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('bandcamp.com')) return 'bandcamp';
    if (host.endsWith('qobuz.com')) return 'qobuz';
    if (host.endsWith('mirlo.space')) return 'mirlo';
    if (host.endsWith('ninaprotocol.com')) return 'nina';
    if (host.endsWith('ampwall.com')) return 'ampwall';
    if (host.endsWith('discogs.com')) return 'discogs';
    if (host.endsWith('patreon.com')) return 'patreon';
    if (host.endsWith('buymeacoffee.com')) return 'buymeacoffee';
    if (host.endsWith('ko-fi.com')) return 'kofi';
    if (host.endsWith('beatport.com')) return 'beatport';
    if (host.endsWith('even.biz')) return 'even';
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply manual merge overrides (runs before release-based disambiguation)
// ---------------------------------------------------------------------------

export function applyMergeOverrides(
  aggregated: AggregatedResult[],
  overrides: MergeOverride[],
): void {
  for (const override of overrides) {
    const overrideUrls = new Set(
      override.platform_urls.map(u => u.replace(/\/+$/, '').toLowerCase())
    );

    // Generic search/explore URLs (e.g. buymeacoffee.com/explore-creators,
    // duckduckgo.com site-search) appear in every query's results, so they
    // must not participate in the relevance match or every search would
    // trigger the override.
    const relevanceUrls = new Set(
      override.platform_urls
        .filter(u => {
          const sid = sourceIdFromUrl(u);
          return sid ? !isSearchOnlyLink({ sourceId: sid, url: u }) : true;
        })
        .map(u => u.replace(/\/+$/, '').toLowerCase())
    );

    // Step 1: Check if this override is relevant to the current search.
    // Only apply if at least one real override URL appears in the search results.
    const hasRelevantResult = relevanceUrls.size > 0 && aggregated.some(r =>
      r.platforms.some(p => relevanceUrls.has(p.url.replace(/\/+$/, '').toLowerCase()))
    );
    if (!hasRelevantResult) continue;

    // Step 2: Strip ALL override URLs from every existing result.
    // The override result will be the sole owner of these URLs.
    for (const result of aggregated) {
      const before = result.platforms.length;
      result.platforms = result.platforms.filter(p =>
        !overrideUrls.has(p.url.replace(/\/+$/, '').toLowerCase())
      );
      if (result.platforms.length < before) {
        console.log(`[Override] Stripped ${before - result.platforms.length} URL(s) from "${result.name}" (claimed by "${override.group_name}")`);
      }
    }

    // Step 2: Remove results that have no real platforms left (only search-only or empty)
    for (let i = aggregated.length - 1; i >= 0; i--) {
      const hasRealPlatform = aggregated[i].platforms.some(p => !isSearchOnlyLink(p));
      if (!hasRealPlatform) {
        console.log(`[Override] Removed empty result "${aggregated[i].name}" after URL stripping`);
        aggregated.splice(i, 1);
      }
    }

    // Step 3: Build the override's platform list from its URLs
    const overridePlatforms: { sourceId: SourceId; url: string }[] = [];
    for (const url of override.platform_urls) {
      const sourceId = sourceIdFromUrl(url);
      if (sourceId && !isSearchOnlyLink({ sourceId, url })) {
        overridePlatforms.push({ sourceId, url });
      }
    }

    // Step 4: Create the override result and add it to the front
    if (overridePlatforms.length > 0) {
      const overrideResult: AggregatedResult = {
        id: `override-${normalizeForComparison(override.group_name)}`,
        name: override.group_name,
        type: 'artist',
        imageUrl: override.canonical_image_url || undefined,
        platforms: overridePlatforms,
        matchConfidence: 'verified',
        overrideMerged: true,
      };

      // Add search-only links for discoverability
      overrideResult.platforms.push(
        { sourceId: 'ampwall' as SourceId, url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(override.group_name)}` },
        { sourceId: 'kofi' as SourceId, url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(override.group_name)}` },
        { sourceId: 'buymeacoffee' as SourceId, url: 'https://buymeacoffee.com/explore-creators' },
      );

      aggregated.unshift(overrideResult);
      console.log(`[Override] Created result for "${override.group_name}" with ${overridePlatforms.length} platform(s)`);
    }
  }
}

// ---------------------------------------------------------------------------
// String normalization
// ---------------------------------------------------------------------------

// Normalize accented characters to their ASCII equivalents
// e.g., "Tanerélle" -> "Tanerelle", "Björk" -> "Bjork"
export function normalizeAccents(str: string): string {
  // Unicode NFD normalization decomposes accented characters
  // e.g., "é" becomes "e" + combining acute accent
  // Then we remove the combining diacritical marks (U+0300 to U+036F)
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normalize a search query for API calls
// Removes accents but preserves spaces and basic punctuation
export function normalizeSearchQuery(query: string): string {
  return normalizeAccents(query);
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

export function normalizeForComparison(str: string): string {
  // First normalize accents, then lowercase and remove non-alphanumeric
  return normalizeAccents(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Candidate `<slug>.bandcamp.com` subdomains for an artist name, most likely first.
 *
 * Bandcamp's search page is blocked and robots-disallowed, so artist URLs are
 * found by probing these candidates and verifying the resulting page. Measured
 * recall against 3,018 known artists (docs/specs/bandcamp-coverage-research.md):
 *
 *   1 candidate  (base)          66.3%
 *   2 candidates (+strip "the")  69.3%
 *   3 candidates (+hyphenated)   71.1%
 *
 * The curve then flattens hard — eleven candidates reach only 74.8%, so probes
 * 4+ cost 8x the requests for under four points. Three is the deliberate stop.
 * (True recall is higher than these figures, ~80%, because Bandcamp itself
 * redirects some alias slugs to the right artist.)
 */
export function bandcampSlugCandidates(name: string): string[] {
  const base = normalizeForComparison(name);
  const withoutThe = normalizeForComparison(name.replace(/^\s*the\s+/i, ''));
  const hyphenated = normalizeAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const candidates: string[] = [];
  for (const candidate of [base, withoutThe, hyphenated]) {
    // Bandcamp subdomains are at least 3 characters; skip empties and dupes.
    if (candidate.length >= 3 && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

// Check if two names are similar enough to be considered a match
// Returns true if names match closely (same name, or one contains the other)
export function namesMatch(name1: string, name2: string): boolean {
  const n1 = normalizeForComparison(name1);
  const n2 = normalizeForComparison(name2);

  // Exact match
  if (n1 === n2) return true;

  // One contains the other (e.g., "Kid Lightbulbs" matches "Kid Lightbulbs Music")
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Check if it's just a typo/variation (allow 1-2 char difference for short names)
  if (n1.length <= 10 && n2.length <= 10) {
    // For short names, require very close match
    const minLen = Math.min(n1.length, n2.length);
    const maxLen = Math.max(n1.length, n2.length);
    if (maxLen - minLen > 2) return false;

    // Count matching characters
    let matches = 0;
    for (let i = 0; i < minLen; i++) {
      if (n1[i] === n2[i]) matches++;
    }
    // Require 80%+ character match
    return matches >= minLen * 0.8;
  }

  return false;
}

export function textMatchScore(name: string, query: string): number {
  const normName = normalizeForComparison(name);
  const normQuery = normalizeForComparison(query);
  if (normName === normQuery) return 3;
  if (normName.startsWith(normQuery)) return 2;
  if (normName.includes(normQuery)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// ID / identifier helpers
// ---------------------------------------------------------------------------

export function generateResultId(name: string, artist?: string): string {
  const normalized = normalizeForComparison(artist ? `${artist}-${name}` : name);
  return normalized || Math.random().toString(36).substring(2);
}

// Extract the subdomain/identifier from a platform URL for uniqueness checking
export function extractPlatformIdentifier(url: string, sourceId: SourceId): string {
  try {
    const urlObj = new URL(url);
    if (sourceId === 'bandcamp') {
      // For Bandcamp, the subdomain is the unique identifier
      // e.g., "corymiller" from "corymiller.bandcamp.com"
      const match = urlObj.hostname.match(/^([^.]+)\.bandcamp\.com$/);
      return match ? match[1] : urlObj.hostname;
    }
    // For other platforms, use the full path
    return urlObj.pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Pipeline constants and helpers
// ---------------------------------------------------------------------------

// Search-only platforms: links that are just search URLs, not real presences
export const SEARCH_ONLY_PLATFORMS = new Set(['kofi', 'buymeacoffee']);
export function isSearchOnlyLink(p: { sourceId: SourceId; url: string }): boolean {
  if (SEARCH_ONLY_PLATFORMS.has(p.sourceId)) return true;
  if (p.sourceId === 'ampwall' && p.url.includes('explore?searchStyle=search')) return true;
  return false;
}

// Platforms where "no releases" is reliable evidence of a different artist
export const RELIABLE_RELEASE_PLATFORMS = new Set(['bandcamp']);

// Curated platforms where presence is strong verification signal
export const CURATED_PLATFORMS = new Set(['mirlo', 'faircamp', 'jamcoop']);

/**
 * Pick the best Qobuz artist link out of a set of MusicBrainz relation URLs.
 *
 * MusicBrainz is our only source of Qobuz links: a Qobuz artist URL needs a numeric ID
 * that cannot be derived from the artist name, and every Qobuz search path is Disallow'ed
 * in their robots.txt. See docs/specs/qobuz-coverage-research.md.
 *
 * MB stores two shapes for the same artist. Prefer the www one — it is the human-readable
 * web page — and fall back to open.qobuz.com when that is all MB has.
 */
export function pickQobuzUrl(platformUrls: string[]): string | null {
  let openQobuzUrl: string | null = null;

  for (const url of platformUrls) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (hostname === 'www.qobuz.com' || hostname === 'qobuz.com') return url;
    if (hostname === 'open.qobuz.com' && !openQobuzUrl) openQobuzUrl = url;
  }

  return openQobuzUrl;
}

// Collect all release titles from a result's platforms into a Set
export function collectReleaseTitles(result: AggregatedResult): Set<string> {
  const titles = new Set<string>();
  for (const p of result.platforms) {
    if (p.allReleaseTitles) p.allReleaseTitles.forEach(t => titles.add(t));
    if (p.latestRelease?.title) titles.add(normalizeForComparison(p.latestRelease.title));
  }
  return titles;
}

// Reconstruct a display name from a URL slug (e.g. "ben-g" → "Ben G").
// Strips trailing numeric suffixes that platforms use for disambiguation
// (e.g. "ben-g-1" → "Ben G", not "Ben G 1").
// If an original query is provided and its normalized form matches,
// prefer the query since it preserves special characters (e.g. "Ben-G!").
export function displayNameFromSlug(slug: string, originalQuery?: string): string {
  // Strip trailing numeric segment (platform disambiguation, not part of the name)
  const cleanSlug = slug.replace(/-\d+$/, '');
  const reconstructed = cleanSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (originalQuery && normalizeForComparison(originalQuery) === normalizeForComparison(reconstructed)) {
    return originalQuery;
  }
  return reconstructed;
}

// ---------------------------------------------------------------------------
// Phase 1: Aggregate — merge same-name Bandcamp/Mirlo results
// ---------------------------------------------------------------------------

export function aggregateResults(allResults: PlatformResult[], query?: string): AggregatedResult[] {
  const resultMap = new Map<string, AggregatedResult>();

  for (const result of allResults) {
    if (result.name.startsWith('Search "')) continue;

    const baseKey = generateResultId(result.name, result.artist);
    const platformId = extractPlatformIdentifier(result.url, result.sourceId);

    if (resultMap.has(baseKey)) {
      const existing = resultMap.get(baseKey)!;
      const existingPlatform = existing.platforms.find(p => p.sourceId === result.sourceId);

      if (!existingPlatform) {
        existing.platforms.push({ sourceId: result.sourceId, url: result.url, allReleaseTitles: result.allReleaseTitles });
      } else {
        // Same platform type — split if different URL (different artist on same platform)
        const existingPlatformId = extractPlatformIdentifier(existingPlatform.url, existingPlatform.sourceId);
        if (existingPlatformId !== platformId) {
          const uniqueKey = `${baseKey}-${result.sourceId}-${platformId}`;
          if (!resultMap.has(uniqueKey)) {
            resultMap.set(uniqueKey, {
              id: uniqueKey,
              name: result.name,
              artist: result.artist,
              type: result.type,
              imageUrl: result.imageUrl,
              platforms: [{ sourceId: result.sourceId, url: result.url, allReleaseTitles: result.allReleaseTitles }],
            });
            console.log(`[Aggregation] Created separate entry for "${result.name}" - different ${result.sourceId} profile: ${platformId}`);
          }
        }
      }
      if (!existing.imageUrl && result.imageUrl) existing.imageUrl = result.imageUrl;
    } else {
      resultMap.set(baseKey, {
        id: baseKey,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: result.imageUrl,
        platforms: [{ sourceId: result.sourceId, url: result.url, allReleaseTitles: result.allReleaseTitles }],
      });
    }
  }

  return Array.from(resultMap.values())
    .sort((a, b) => {
      if (query) {
        const scoreA = textMatchScore(a.name, query);
        const scoreB = textMatchScore(b.name, query);
        if (scoreA !== scoreB) return scoreB - scoreA;
      }
      return b.platforms.length - a.platforms.length;
    });
}

// ---------------------------------------------------------------------------
// Phase 2: Attach Ampwall and search-only links to aggregated results
// ---------------------------------------------------------------------------

export function attachAmpwallAndSearchLinks(
  aggregated: AggregatedResult[],
  ampwallMatches: Map<string, string>,
  mbData?: { artistName: string; bandcampUrl?: string } | null,
): void {
  const usedPlatformUrls = new Set<string>();

  for (const result of aggregated) {
    if (result.type !== 'artist') continue;
    const normalizedName = normalizeForComparison(result.name);

    // Ampwall: prefer API match, fall back to search URL for all artists
    if (ampwallMatches.has(normalizedName)) {
      const url = ampwallMatches.get(normalizedName)!;
      if (!usedPlatformUrls.has(url)) {
        result.platforms.push({ sourceId: 'ampwall', url });
        usedPlatformUrls.add(url);
      }
    } else {
      result.platforms.push({
        sourceId: 'ampwall',
        url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(result.name)}`,
      });
    }

    // Ko-fi and BuyMeACoffee search links for all artists
    result.platforms.push(
      { sourceId: 'kofi', url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(result.name)}` },
      { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
    );

    // Bandcamp: prefer direct URL from MusicBrainz relations, fall back to search link
    if (!result.platforms.some(p => p.sourceId === 'bandcamp')) {
      // Check if MusicBrainz has a direct Bandcamp URL for this artist
      const mbBandcampUrl = mbData?.bandcampUrl &&
        normalizeForComparison(mbData.artistName) === normalizedName
        ? mbData.bandcampUrl
        : undefined;

      if (mbBandcampUrl) {
        result.platforms.push({ sourceId: 'bandcamp', url: mbBandcampUrl });
      } else {
        result.platforms.push({
          sourceId: 'bandcamp',
          url: `https://bandcamp.com/search?q=${encodeURIComponent(result.name)}`,
        });
      }
    }

    // Sort: real platforms first, search-only last
    result.platforms.sort((a, b) => {
      const aSearch = isSearchOnlyLink(a) ? 1 : 0;
      const bSearch = isSearchOnlyLink(b) ? 1 : 0;
      return aSearch - bSearch;
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 3 pure functions
// ---------------------------------------------------------------------------

// Split results where Bandcamp has releases that don't match other platforms
export function splitSuspiciousPlatforms(aggregated: AggregatedResult[]): AggregatedResult[] {
  const disambiguated: AggregatedResult[] = [];

  for (const result of aggregated) {
    if (result.overrideMerged) {
      disambiguated.push(result);
      continue;
    }
    const withReleases = result.platforms.filter(p => p.latestRelease);
    const withoutReleases = result.platforms.filter(p => !p.latestRelease);
    const hasCurated = result.platforms.some(p => CURATED_PLATFORMS.has(p.sourceId));
    const suspicious = withoutReleases.filter(p => RELIABLE_RELEASE_PLATFORMS.has(p.sourceId));

    // No platforms have releases
    if (withReleases.length === 0) {
      result.matchConfidence = hasCurated ? 'verified' : 'unverified';
      disambiguated.push(result);
      continue;
    }

    // Check suspicious platforms (Bandcamp with no releases) against verified release data
    if (suspicious.length > 0 && withReleases.length > 0) {
      const verifiedTitles = new Set<string>();
      for (const p of withReleases) {
        if (p.allReleaseTitles) p.allReleaseTitles.forEach(t => verifiedTitles.add(t));
        if (p.latestRelease?.title) verifiedTitles.add(normalizeForComparison(p.latestRelease.title));
      }

      const trulyUnverified: typeof suspicious = [];
      for (const platform of suspicious) {
        if (platform.allReleaseTitles?.length) {
          const hasMatch = platform.allReleaseTitles.some(t => verifiedTitles.has(t));
          if (hasMatch) {
            console.log(`[Disambiguation] "${result.name}" - ${platform.sourceId} has matching release`);
            withReleases.push(platform);
          } else {
            trulyUnverified.push(platform);
          }
        } else {
          // No release data — could be scraping failure, keep with verified
          console.log(`[Disambiguation] "${result.name}" - ${platform.sourceId} has no release data, keeping with verified result`);
          withReleases.push(platform);
        }
      }

      if (trulyUnverified.length > 0) {
        console.log(`[Disambiguation] Splitting "${result.name}": ${trulyUnverified.map(p => p.sourceId).join(', ')} have non-matching releases`);

        // Verified result keeps all platforms except the truly-unverified reliable ones
        const verifiedImageUrl = withReleases.find(p => p.latestRelease?.imageUrl)?.latestRelease?.imageUrl;
        disambiguated.push({
          id: result.id,
          name: result.name,
          artist: result.artist,
          type: result.type,
          imageUrl: verifiedImageUrl || result.imageUrl,
          platforms: [...withReleases, ...withoutReleases.filter(p => !RELIABLE_RELEASE_PLATFORMS.has(p.sourceId))],
          matchConfidence: 'verified',
        });

        // Each truly-unverified platform becomes its own result
        for (const platform of trulyUnverified) {
          disambiguated.push({
            id: `${result.id}-${platform.sourceId}`,
            name: result.name,
            artist: result.artist,
            type: result.type,
            imageUrl: result.imageUrl,
            platforms: [platform],
            matchConfidence: 'unverified',
          });
        }
        continue;
      }

      // All suspicious platforms verified or kept due to no data
      result.platforms = [...withReleases, ...withoutReleases.filter(p => !RELIABLE_RELEASE_PLATFORMS.has(p.sourceId))];
      result.matchConfidence = 'verified';
      disambiguated.push(result);
      continue;
    }

    // No suspicious platforms — keep as verified
    result.matchConfidence = 'verified';
    disambiguated.push(result);
  }

  return disambiguated;
}

// Merge same-name results only when release titles overlap
export function mergeByReleaseOverlap(disambiguated: AggregatedResult[]): AggregatedResult[] {
  const mergedMap = new Map<string, AggregatedResult>();

  for (const result of disambiguated) {
    if (result.type !== 'artist') {
      mergedMap.set(result.id, result);
      continue;
    }

    const normName = normalizeForComparison(result.name);
    const existing = [...mergedMap.values()].find(
      r => r.type === 'artist' && normalizeForComparison(r.name) === normName
    );

    if (!existing) {
      mergedMap.set(result.id, result);
      continue;
    }

    // Never merge results that share the same platform (e.g. two different Bandcamp profiles).
    // These were deliberately split during aggregation as different artists on the same platform.
    const existingSourceIds = new Set(existing.platforms.map(p => p.sourceId));
    const hasSharedPlatform = result.platforms.some(p => existingSourceIds.has(p.sourceId));
    if (hasSharedPlatform) {
      mergedMap.set(result.id, result);
      console.log(`[Merge] Keeping "${result.name}" separate - shares platform with existing result`);
      continue;
    }

    const existingTitles = collectReleaseTitles(existing);
    const incomingTitles = collectReleaseTitles(result);

    // Merge if either side has no release data, or there's overlap
    const hasOverlap = existingTitles.size === 0 || incomingTitles.size === 0 ||
      [...incomingTitles].some(t => existingTitles.has(t));

    if (hasOverlap) {
      const existingIds = new Set(existing.platforms.map(p => p.sourceId));
      for (const p of result.platforms) {
        if (!existingIds.has(p.sourceId)) {
          existing.platforms.push(p);
          existingIds.add(p.sourceId);
        }
      }
      if (!existing.imageUrl && result.imageUrl) existing.imageUrl = result.imageUrl;
      console.log(`[Merge] Merged duplicate "${result.name}" into existing result (release overlap confirmed)`);
    } else {
      mergedMap.set(result.id, result);
      console.log(`[Merge] Keeping "${result.name}" separate - no release overlap with existing result`);
    }
  }

  return Array.from(mergedMap.values());
}

// ---------------------------------------------------------------------------
// Phase 4: filterAndSort
// ---------------------------------------------------------------------------

export function filterAndSort(results: AggregatedResult[], query: string): AggregatedResult[] {
  // Remove results that only have search-only links
  const filtered = results.filter(r =>
    r.platforms.some(p => !isSearchOnlyLink(p))
  );

  filtered.sort((a, b) => {
    const scoreA = textMatchScore(a.name, query);
    const scoreB = textMatchScore(b.name, query);
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.matchConfidence === 'verified' && b.matchConfidence !== 'verified') return -1;
    if (a.matchConfidence !== 'verified' && b.matchConfidence === 'verified') return 1;
    return b.platforms.length - a.platforms.length;
  });

  return filtered;
}

