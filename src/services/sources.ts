import type { Source, SourceId, SearchResponse, SearchResult } from '../types';

export const sources: Record<SourceId, Source> = {
  bandcamp: {
    id: 'bandcamp',
    name: 'Bandcamp',
    description: 'Artist-friendly music marketplace',
    color: '#1da0c3',
    icon: '🎵',
    category: 'marketplace',
    hasEmbed: true,
    searchUrlTemplate: 'https://bandcamp.com/search?q={query}',
    homepageUrl: 'https://bandcamp.com',
  },
  mirlo: {
    id: 'mirlo',
    name: 'Mirlo',
    description: 'Open source patronage platform',
    color: '#6366f1',
    icon: '🪺',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://mirlo.space/search?query={query}',
    homepageUrl: 'https://mirlo.space',
  },
  ampwall: {
    id: 'ampwall',
    name: 'Ampwall',
    description: 'Modern independent music platform',
    color: '#ef4444',
    icon: '🔊',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://ampwall.com/explore?searchStyle=search&query={query}',
    searchOnly: true,
    homepageUrl: 'https://ampwall.com',
  },
  sonica: {
    id: 'sonica',
    name: 'Sonica',
    description: 'Artist-owned music platform',
    color: '#10b981',
    icon: '🎶',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://sonica.music/search/{query}',
    searchOnly: true,
    homepageUrl: 'https://sonica.music',
  },
  bandwagon: {
    id: 'bandwagon',
    name: 'Bandwagon',
    description: 'ActivityPub-based music community',
    color: '#8b5cf6',
    icon: '🚐',
    category: 'decentralized',
    hasEmbed: false,
    searchUrlTemplate: 'https://bandwagon.fm/artists?q={query}',
    homepageUrl: 'https://bandwagon.fm',
  },
  faircamp: {
    id: 'faircamp',
    name: 'Faircamp',
    description: 'Decentralized static music sites',
    color: '#22c55e',
    icon: '🏕️',
    category: 'decentralized',
    hasEmbed: false,
    searchUrlTemplate: 'https://duckduckgo.com/?q=site:*.faircamp+{query}',
    homepageUrl: 'https://simonrepp.com/faircamp',
  },
  patreon: {
    id: 'patreon',
    name: 'Patreon',
    description: 'Creator subscription platform',
    color: '#ff424d',
    icon: '🎨',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.patreon.com/search?q={query}',
    homepageUrl: 'https://www.patreon.com',
  },
  buymeacoffee: {
    id: 'buymeacoffee',
    name: 'Buy Me a Coffee',
    description: 'Creator support platform',
    color: '#ffdd00',
    icon: '☕',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://buymeacoffee.com/explore-creators',
    searchOnly: true,
    homepageUrl: 'https://buymeacoffee.com',
  },
  kofi: {
    id: 'kofi',
    name: 'Ko-fi',
    description: 'Creator tip jar and shop',
    color: '#29abe0',
    icon: '🍵',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://duckduckgo.com/?q=site:ko-fi.com+{query}',
    searchOnly: true,
    homepageUrl: 'https://ko-fi.com',
  },
  hoopla: {
    id: 'hoopla',
    name: 'Hoopla',
    description: 'Library streaming service',
    color: '#9333ea',
    icon: '🎧',
    category: 'library',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.hoopladigital.com/search?q={query}&type=music',
    homepageUrl: 'https://www.hoopladigital.com',
  },
  freegal: {
    id: 'freegal',
    name: 'Freegal',
    description: 'Free library music streaming',
    color: '#e91e63',
    icon: '🎵',
    category: 'library',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.freegalmusic.com/search-page/{query}',
    homepageUrl: 'https://www.freegalmusic.com',
  },
  qobuz: {
    id: 'qobuz',
    name: 'Qobuz',
    description: 'Hi-res music downloads store',
    color: '#0070f3',
    icon: '💿',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.qobuz.com/us-en/search/artists/{query}',
    homepageUrl: 'https://www.qobuz.com',
  },
  jamcoop: {
    id: 'jamcoop',
    name: 'Jam.coop',
    description: 'Artist-owned music cooperative',
    color: '#e11d48',
    icon: '🎸',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://jam.coop/artists',
    homepageUrl: 'https://jam.coop',
  },
  officialsite: {
    id: 'officialsite',
    name: 'Official Site',
    description: 'Artist\'s official website',
    color: '#71717a',
    icon: '🌐',
    category: 'official',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: '',
  },
  discogs: {
    id: 'discogs',
    name: 'Discogs',
    description: 'Music database and marketplace',
    color: '#333333',
    icon: '💿',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.discogs.com/search/?q={query}&type=artist',
    homepageUrl: 'https://www.discogs.com',
  },
  // Social platforms
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    description: 'Photo and video sharing',
    color: '#E4405F',
    icon: 'instagram',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://www.instagram.com',
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    description: 'Social networking',
    color: '#1877F2',
    icon: 'facebook',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://www.facebook.com',
  },
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    description: 'Short-form video',
    color: '#E0E0E0',
    icon: 'tiktok',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://www.tiktok.com',
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    description: 'Video platform',
    color: '#FF0000',
    icon: 'youtube',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://www.youtube.com',
  },
  threads: {
    id: 'threads',
    name: 'Threads',
    description: 'Text-based social network',
    color: '#E0E0E0',
    icon: 'threads',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://www.threads.net',
  },
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    description: 'Decentralized social network',
    color: '#0085FF',
    icon: 'bluesky',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://bsky.app',
  },
  twitter: {
    id: 'twitter',
    name: 'X',
    description: 'Social network',
    color: '#E0E0E0',
    icon: 'twitter',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://x.com',
  },
  mastodon: {
    id: 'mastodon',
    name: 'Mastodon',
    description: 'Decentralized social network',
    color: '#6364FF',
    icon: 'mastodon',
    category: 'social',
    hasEmbed: false,
    searchUrlTemplate: '',
    homepageUrl: 'https://joinmastodon.org',
  },
};

export const sourceCategories = {
  marketplace: {
    name: 'Music Marketplaces',
    description: 'Buy music directly from artists',
    sources: ['bandcamp', 'mirlo', 'ampwall', 'sonica', 'qobuz', 'jamcoop', 'discogs'] as SourceId[],
  },
  patronage: {
    name: 'Patronage Platforms',
    description: 'Support artists directly',
    sources: ['patreon', 'buymeacoffee', 'kofi'] as SourceId[],
  },
  library: {
    name: 'Library Services',
    description: 'Access through your local library',
    sources: ['hoopla', 'freegal'] as SourceId[],
  },
  decentralized: {
    name: 'Decentralized',
    description: 'ActivityPub and self-hosted platforms',
    sources: ['bandwagon', 'faircamp'] as SourceId[],
  },
  official: {
    name: 'Official',
    description: 'Artist websites and profiles',
    sources: ['officialsite'] as SourceId[],
  },
  social: {
    name: 'Social',
    description: 'Artist social media profiles',
    sources: ['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'twitter', 'mastodon'] as SourceId[],
  },
};

/**
 * Parse a query to extract multiple artist names from collaborative tracks.
 * Handles patterns like:
 * - "Mo-Rice and Babebee"
 * - "Mo-Rice feat. Babebee"
 * - "Mo-Rice, Babebee"
 * - "Mo-Rice + Babebee"
 * - "Kid Lightbulbs x ilyBBY"
 *
 * Returns an array of individual artist names. If no separators found, returns the original query.
 */
function parseMultiArtistQuery(query: string): string[] {
  // Pattern matches common collaboration separators
  // Note: " x " requires spaces to avoid splitting names like "The xx"
  const separatorPattern = /\s+(?:and|&|feat\.?|featuring|,|\+|x)\s+/gi;

  const parts = query.split(separatorPattern)
    .map(part => part.trim())
    .filter(part => part.length > 0);

  return parts.length > 1 ? parts : [query];
}

/**
 * Normalize a string for comparison (lowercase, alphanumeric only)
 */
function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Merge multiple search responses, deduplicating results by normalized name
 */
function mergeSearchResponses(responses: SearchResponse[], originalQuery: string): SearchResponse {
  const resultMap = new Map<string, SearchResult>();

  for (const response of responses) {
    for (const result of response.results) {
      // Generate a key for deduplication based on normalized name + artist
      const key = normalizeForComparison(result.artist ? `${result.artist}-${result.name}` : result.name);

      if (resultMap.has(key)) {
        // Merge platforms from duplicate result
        const existing = resultMap.get(key)!;
        for (const platform of result.platforms) {
          if (!existing.platforms.some(p => p.sourceId === platform.sourceId)) {
            existing.platforms.push(platform);
          }
        }
        // Use image if we don't have one
        if (!existing.imageUrl && result.imageUrl) {
          existing.imageUrl = result.imageUrl;
        }
        // Upgrade match confidence if verified
        if (result.matchConfidence === 'verified') {
          existing.matchConfidence = 'verified';
        }
      } else {
        // Add new result (clone to avoid mutation)
        resultMap.set(key, {
          ...result,
          platforms: [...result.platforms],
        });
      }
    }
  }

  // Sort by number of platforms (most platforms first)
  const mergedResults = Array.from(resultMap.values())
    .sort((a, b) => b.platforms.length - a.platforms.length);

  return {
    query: originalQuery,
    results: mergedResults,
  };
}

/**
 * Perform a single search API call
 */
async function searchSingle(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams({ query });

  try {
    const response = await fetch(`/api/search/sources?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to search platforms:', error);
    return {
      query,
      results: [],
    };
  }
}

// Search all platforms via the unified API
// Handles multi-artist queries by searching each artist separately and merging results
export async function searchPlatforms(query: string): Promise<SearchResponse> {
  const artistQueries = parseMultiArtistQuery(query);

  // If single artist (no separators found), do a simple search
  if (artistQueries.length === 1) {
    return searchSingle(query);
  }

  // Multi-artist query: search for the full query AND each individual artist
  // This handles both "Artist1 feat. Artist2" collabs AND bands with conjunctions
  // like "Daryl Hall & John Oates" (which should also return the full band name)
  const allQueries = [query, ...artistQueries];

  // Deduplicate queries (in case parsing produced the same string)
  const uniqueQueries = [...new Set(allQueries.map(q => q.toLowerCase()))]
    .map(lowerQ => allQueries.find(q => q.toLowerCase() === lowerQ)!);

  // Search all queries in parallel
  const responses = await Promise.all(uniqueQueries.map(q => searchSingle(q)));

  // Merge and deduplicate results
  return mergeSearchResponses(responses, query);
}

// Resolve artist name from a Spotify or Apple Music URL
export interface ResolveResult {
  artistName: string;
  source: 'spotify' | 'apple';
}

export async function resolveArtistUrl(url: string): Promise<ResolveResult | null> {
  try {
    const response = await fetch(`/api/resolve/url?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to resolve URL:', error);
    return null;
  }
}

// Fetch MusicBrainz data for lazy loading enrichment
export async function fetchMusicBrainzData(query: string): Promise<import('../types').MusicBrainzData | null> {
  try {
    const response = await fetch(`/api/search/musicbrainz?query=${encodeURIComponent(query)}`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch MusicBrainz data:', error);
    return null;
  }
}

// Merge MusicBrainz data with existing search results
// Adds officialsite, discogs, hoopla, and freegal platforms to matching artist results
export function mergeWithMusicBrainzData(
  results: import('../types').SearchResult[],
  mbData: import('../types').MusicBrainzData
): import('../types').SearchResult[] {
  if (!mbData.artistName) return results;

  const mbNormalized = normalizeForComparison(mbData.artistName);

  return results.map(result => {
    // Only add to artist results
    if (result.type !== 'artist') return result;

    const resultNormalized = normalizeForComparison(result.name);

    // Check if artist name matches (exact, contains, or is contained by)
    const isMatch =
      resultNormalized === mbNormalized ||
      resultNormalized.includes(mbNormalized) ||
      mbNormalized.includes(resultNormalized);

    if (!isMatch) return result;

    // Clone platforms array for immutable update
    const newPlatforms = [...result.platforms];

    // Add official site if available and not already present
    if (mbData.officialUrl && !newPlatforms.some(p => p.sourceId === 'officialsite')) {
      newPlatforms.push({ sourceId: 'officialsite', url: mbData.officialUrl });
    }

    // Add Discogs if available and not already present
    if (mbData.discogsUrl && !newPlatforms.some(p => p.sourceId === 'discogs')) {
      newPlatforms.push({ sourceId: 'discogs', url: mbData.discogsUrl });
    }

    // Add library services for artists with pre-2005 releases
    if (mbData.hasPre2005Release) {
      if (!newPlatforms.some(p => p.sourceId === 'hoopla')) {
        newPlatforms.push({
          sourceId: 'hoopla',
          url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(result.name)}&type=music`,
        });
      }
      if (!newPlatforms.some(p => p.sourceId === 'freegal')) {
        newPlatforms.push({
          sourceId: 'freegal',
          url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(result.name)}`,
        });
      }
    }

    // Add social links if available
    // These are direct links from official sites, so they should replace search URLs
    if (mbData.socialLinks && mbData.socialLinks.length > 0) {
      for (const social of mbData.socialLinks) {
        const existingIndex = newPlatforms.findIndex(p => p.sourceId === social.platform);
        if (existingIndex === -1) {
          // Platform doesn't exist yet, add it
          newPlatforms.push({ sourceId: social.platform, url: social.url });
        } else {
          // Platform exists - replace if existing URL is a search URL and new one is direct
          const existingUrl = newPlatforms[existingIndex].url.toLowerCase();
          const isExistingSearchUrl = existingUrl.includes('duckduckgo.com') ||
            existingUrl.includes('/search') ||
            existingUrl.includes('?q=') ||
            existingUrl.includes('?query=') ||
            existingUrl.includes('/explore');
          if (isExistingSearchUrl) {
            newPlatforms[existingIndex] = { sourceId: social.platform, url: social.url };
          }
        }
      }
    }

    // Re-sort platforms: verified first, search-only in middle, official/library, then social last
    const searchOnlyPlatforms = new Set(['ampwall', 'sonica', 'kofi', 'buymeacoffee']);
    const officialPlatforms = new Set(['officialsite', 'discogs', 'hoopla', 'freegal']);
    const socialPlatforms = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'twitter', 'mastodon']);
    newPlatforms.sort((a, b) => {
      const aIsSocial = socialPlatforms.has(a.sourceId);
      const bIsSocial = socialPlatforms.has(b.sourceId);
      // Social platforms come last
      if (aIsSocial && !bIsSocial) return 1;
      if (!aIsSocial && bIsSocial) return -1;
      if (aIsSocial && bIsSocial) {
        // Order social platforms consistently
        const order = ['instagram', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'facebook', 'twitter'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }

      const aIsOfficial = officialPlatforms.has(a.sourceId);
      const bIsOfficial = officialPlatforms.has(b.sourceId);
      if (aIsOfficial && bIsOfficial) {
        // Order: officialsite, discogs, hoopla, freegal
        const order = ['officialsite', 'discogs', 'hoopla', 'freegal'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }
      if (aIsOfficial) return 1;
      if (bIsOfficial) return -1;
      const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
      const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
      if (aIsSearchOnly && !bIsSearchOnly) return 1;
      if (!aIsSearchOnly && bIsSearchOnly) return -1;
      return 0;
    });

    return { ...result, platforms: newPlatforms };
  });
}
