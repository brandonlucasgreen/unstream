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
  | 'officialsite'
  | 'discogs';

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
    // Normalize override URLs for comparison
    const overrideUrls = new Set(override.platform_urls.map(u => u.replace(/\/+$/, '').toLowerCase()));

    // Find all results that match by URL or by name
    const overrideName = normalizeForComparison(override.group_name);
    const matchingIndices: number[] = [];
    for (let i = 0; i < aggregated.length; i++) {
      const hasUrlMatch = aggregated[i].platforms.some(p =>
        overrideUrls.has(p.url.replace(/\/+$/, '').toLowerCase())
      );
      const hasNameMatch = normalizeForComparison(aggregated[i].name) === overrideName;
      if (hasUrlMatch || hasNameMatch) matchingIndices.push(i);
    }

    if (matchingIndices.length === 0) continue;

    // Determine the primary result (merge others into it if multiple)
    const primary = aggregated[matchingIndices[0]];

    if (matchingIndices.length > 1) {
      // Merge all matching results into the first one
      const existingSourceIds = new Set(primary.platforms.map(p => p.sourceId));

      for (let i = 1; i < matchingIndices.length; i++) {
        const other = aggregated[matchingIndices[i]];
        for (const p of other.platforms) {
          if (!existingSourceIds.has(p.sourceId)) {
            primary.platforms.push(p);
            existingSourceIds.add(p.sourceId);
          }
        }
        if (!primary.imageUrl && other.imageUrl) {
          primary.imageUrl = other.imageUrl;
        }
      }

      console.log(`[Override] Merged ${matchingIndices.length} results for "${override.group_name}"`);

      // Remove the merged results (iterate in reverse to keep indices stable)
      for (let i = matchingIndices.length - 1; i >= 1; i--) {
        aggregated.splice(matchingIndices[i], 1);
      }
    } else {
      console.log(`[Override] Protected "${override.group_name}" from disambiguation (all URLs on one result)`);
    }

    // Inject any override URLs that aren't already on the result (e.g. Qobuz search missed them)
    const existingUrls = new Set(primary.platforms.map(p => p.url.replace(/\/+$/, '').toLowerCase()));
    for (const url of override.platform_urls) {
      const normalized = url.replace(/\/+$/, '').toLowerCase();
      if (existingUrls.has(normalized)) continue;
      const sourceId = sourceIdFromUrl(url);
      if (sourceId) {
        primary.platforms.push({ sourceId, url });
        console.log(`[Override] Injected missing ${sourceId} URL for "${override.group_name}": ${url}`);
      }
    }

    // Remove excluded URLs from the merged result
    if (override.excluded_urls.length > 0) {
      const excludedSet = new Set(override.excluded_urls.map(u => u.replace(/\/+$/, '').toLowerCase()));
      const removed = primary.platforms.filter(p => excludedSet.has(p.url.replace(/\/+$/, '').toLowerCase()));
      primary.platforms = primary.platforms.filter(p => !excludedSet.has(p.url.replace(/\/+$/, '').toLowerCase()));
      if (removed.length > 0) {
        console.log(`[Override] Removed ${removed.length} excluded URL(s) from "${override.group_name}"`);
      }
    }

    if (override.canonical_image_url) {
      primary.imageUrl = override.canonical_image_url;
    }

    primary.matchConfidence = 'verified';
    primary.overrideMerged = true;
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
    if (sourceId === 'qobuz') {
      // For Qobuz, the artist ID is the unique identifier
      // e.g., "496181" from "/us-en/interpreter/cory-miller/496181"
      const match = urlObj.pathname.match(/\/interpreter\/[^/]+\/(\d+)/);
      return match ? match[1] : urlObj.pathname;
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


// Check if a Qobuz name is a variation of a base name (e.g. "mattyoung1" for "mattyoung")
export function isQobuzVariation(qobuzName: string, baseName: string): boolean {
  return qobuzName === baseName ||
    (qobuzName.startsWith(baseName) && /^\d+$/.test(qobuzName.slice(baseName.length)));
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
// If an original query is provided and its normalized form matches,
// prefer the query since it preserves special characters (e.g. "Ben-G!").
export function displayNameFromSlug(slug: string, originalQuery?: string): string {
  const reconstructed = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (originalQuery && normalizeForComparison(originalQuery) === normalizeForComparison(reconstructed)) {
    return originalQuery;
  }
  return reconstructed;
}

// Extract display name from a Qobuz URL slug
export function qobuzDisplayName(url: string, fallback: string, originalQuery?: string): string {
  const match = url.match(/\/interpreter\/([^/]+)\//);
  return match
    ? displayNameFromSlug(match[1], originalQuery)
    : fallback;
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
        existing.platforms.push({ sourceId: result.sourceId, url: result.url });
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
              platforms: [{ sourceId: result.sourceId, url: result.url }],
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
        platforms: [{ sourceId: result.sourceId, url: result.url }],
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
// Phase 2: Attach Qobuz, Ampwall, and search-only links to aggregated results
// ---------------------------------------------------------------------------

export function attachQobuzAndSearchLinks(
  aggregated: AggregatedResult[],
  qobuzMatches: Map<string, string>,
  ampwallMatches: Map<string, string>,
): void {
  const usedPlatformUrls = new Set<string>();

  for (const result of aggregated) {
    if (result.type !== 'artist') continue;
    const normalizedName = normalizeForComparison(result.name);

    // Ampwall: prefer API match, fall back to search URL for Bandcamp artists
    if (ampwallMatches.has(normalizedName)) {
      const url = ampwallMatches.get(normalizedName)!;
      if (!usedPlatformUrls.has(url)) {
        result.platforms.push({ sourceId: 'ampwall', url });
        usedPlatformUrls.add(url);
      }
    } else if (result.platforms.some(p => p.sourceId === 'bandcamp')) {
      result.platforms.push({
        sourceId: 'ampwall',
        url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(result.name)}`,
      });
    }

    // Ko-fi and BuyMeACoffee search links for Bandcamp artists
    if (result.platforms.some(p => p.sourceId === 'bandcamp')) {
      result.platforms.push(
        { sourceId: 'kofi', url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(result.name)}` },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
      );
    }

    // Qobuz: attach ALL name variations (e.g. "morice", "morice1", "morice2")
    // Disambiguation will sort out which actually match based on releases
    for (const [qobuzName, qobuzUrl] of qobuzMatches) {
      if (isQobuzVariation(qobuzName, normalizedName)) {
        result.platforms.push({ sourceId: 'qobuz', url: qobuzUrl });
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

// Create new results for Qobuz artists not on Bandcamp/Mirlo
export function createQobuzOnlyResults(
  aggregated: AggregatedResult[],
  qobuzMatches: Map<string, string>,
): void {
  const usedQobuzMatches = new Set<string>();
  const aggregatedBaseNames = new Set<string>();

  for (const result of aggregated) {
    const normalizedName = normalizeForComparison(result.name);
    aggregatedBaseNames.add(normalizedName);
    for (const [qobuzName] of qobuzMatches) {
      if (isQobuzVariation(qobuzName, normalizedName)) usedQobuzMatches.add(qobuzName);
    }
  }

  for (const [normalizedName, url] of qobuzMatches) {
    const baseNameWithoutNumbers = normalizedName.replace(/\d+$/, '');
    if (usedQobuzMatches.has(normalizedName) || aggregatedBaseNames.has(baseNameWithoutNumbers)) continue;

    const displayName = qobuzDisplayName(url, normalizedName);
    aggregated.push({
      id: `qobuz-${normalizedName}`,
      name: displayName,
      type: 'artist',
      platforms: [
        { sourceId: 'qobuz', url },
        { sourceId: 'ampwall', url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(displayName)}` },
        { sourceId: 'kofi', url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(displayName)}` },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
      ],
    });
    console.log(`[Qobuz-only] Created result for "${displayName}" from Qobuz match`);
  }
}

// ---------------------------------------------------------------------------
// Phase 3 pure functions
// ---------------------------------------------------------------------------

// Prefer Bandcamp over Qobuz for the featured release (better payouts + preview)
export function preferBandcampFeaturedRelease(aggregated: AggregatedResult[]): void {
  for (const result of aggregated) {
    const bc = result.platforms.find(p => p.sourceId === 'bandcamp');
    const qz = result.platforms.find(p => p.sourceId === 'qobuz');
    if (!bc?.latestRelease || !qz?.latestRelease) continue;

    const bcTitle = normalizeForComparison(bc.latestRelease.title);
    const qzTitle = normalizeForComparison(qz.latestRelease.title);
    if (bcTitle === qzTitle || bcTitle.includes(qzTitle) || qzTitle.includes(bcTitle)) {
      console.log(`[Release Priority] Preferring Bandcamp over Qobuz for "${result.name}" - "${bc.latestRelease.title}"`);
      delete qz.latestRelease;
    }
  }
}

// Remove Qobuz platforms with no releases (dead/placeholder pages)
export function removeDeadQobuzLinks(aggregated: AggregatedResult[]): void {
  for (const result of aggregated) {
    if (result.overrideMerged) continue;
    result.platforms = result.platforms.filter(p => {
      if (p.sourceId !== 'qobuz') return true;
      const hasReleases = p.latestRelease || (p.allReleaseTitles && p.allReleaseTitles.length > 0);
      if (!hasReleases) console.log(`[Cleanup] Removing dead Qobuz link for "${result.name}": ${p.url}`);
      return hasReleases;
    });
  }
}

// Remove Qobuz from results where releases don't match Bandcamp (different artists)
export function crossPlatformReleaseComparison(aggregated: AggregatedResult[]): void {
  for (const result of aggregated) {
    if (result.overrideMerged) continue;
    const bc = result.platforms.find(p => p.sourceId === 'bandcamp');
    if (!bc?.allReleaseTitles || bc.allReleaseTitles.length === 0) continue;

    const bcTitles = new Set(bc.allReleaseTitles);
    const indicesToRemove: number[] = [];

    result.platforms.forEach((p, idx) => {
      if (p.sourceId !== 'qobuz' || !p.allReleaseTitles || p.allReleaseTitles.length === 0) return;

      const matchCount = p.allReleaseTitles.filter(t => bcTitles.has(t)).length;
      const minCatalog = Math.min(bcTitles.size, p.allReleaseTitles.length);
      const threshold = Math.max(1, Math.ceil(minCatalog * 0.3));

      if (matchCount < threshold) {
        console.log(`[Cross-Platform] Removing Qobuz from "${result.name}" - only ${matchCount}/${threshold} matching releases`);
        indicesToRemove.push(idx);
      }
    });

    if (indicesToRemove.length > 0) {
      result.platforms = result.platforms.filter((_, idx) => !indicesToRemove.includes(idx));
    }
  }
}

// If the same Qobuz URL appears on multiple results, keep only on the best match
export function deduplicateQobuzUrls(aggregated: AggregatedResult[]): void {
  const qobuzUrlToResults = new Map<string, { result: AggregatedResult; matchCount: number }[]>();

  for (const result of aggregated) {
    const bcTitles = new Set(
      result.platforms.find(p => p.sourceId === 'bandcamp')?.allReleaseTitles || []
    );
    for (const p of result.platforms) {
      if (p.sourceId !== 'qobuz') continue;
      const matchCount = bcTitles.size > 0 && p.allReleaseTitles?.length
        ? p.allReleaseTitles.filter(t => bcTitles.has(t)).length
        : 0;
      if (!qobuzUrlToResults.has(p.url)) qobuzUrlToResults.set(p.url, []);
      qobuzUrlToResults.get(p.url)!.push({ result, matchCount });
    }
  }

  for (const [qobuzUrl, matches] of qobuzUrlToResults) {
    if (matches.length <= 1) continue;
    matches.sort((a, b) => b.matchCount - a.matchCount);
    for (let i = 1; i < matches.length; i++) {
      if (matches[i].result.overrideMerged) continue;
      console.log(`[Qobuz Dedup] Removing ${qobuzUrl} from "${matches[i].result.name}" (${matches[i].matchCount} matches) - keeping on "${matches[0].result.name}" (${matches[0].matchCount} matches)`);
      matches[i].result.platforms = matches[i].result.platforms.filter(p => p.url !== qobuzUrl);
    }
  }
}

// Re-create standalone results for Qobuz profiles removed from all results
export function createOrphanedQobuzStandalones(
  aggregated: AggregatedResult[],
  qobuzMatches: Map<string, string>,
): void {
  const attachedUrls = new Set<string>();
  for (const r of aggregated) {
    for (const p of r.platforms) {
      if (p.sourceId === 'qobuz') attachedUrls.add(p.url);
    }
  }

  for (const [qobuzName, qobuzUrl] of qobuzMatches) {
    if (attachedUrls.has(qobuzUrl)) continue;

    const displayName = qobuzDisplayName(qobuzUrl, qobuzName);
    const standaloneId = `qobuz-standalone-${qobuzName}`;
    if (aggregated.some(r => r.id === standaloneId)) continue;

    console.log(`[Qobuz Standalone] Creating separate result for "${displayName}" - removed from all Bandcamp results`);
    aggregated.push({
      id: standaloneId,
      name: displayName,
      type: 'artist',
      platforms: [
        { sourceId: 'qobuz', url: qobuzUrl },
        { sourceId: 'ampwall', url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(displayName)}` },
        { sourceId: 'kofi', url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(displayName)}` },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
      ],
    });
  }
}

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

