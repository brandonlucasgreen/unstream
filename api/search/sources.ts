import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'node-html-parser';

type SourceId =
  | 'bandcamp'
  | 'mirlo'
  | 'ampwall'
  | 'bandwagon'
  | 'faircamp'
  | 'patreon'
  | 'buymeacoffee'
  | 'kofi'
  | 'qobuz'
  | 'officialsite'
  | 'discogs';

interface PlatformResult {
  sourceId: SourceId;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  url: string;
  imageUrl?: string;
}

interface AggregatedResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: {
    sourceId: SourceId;
    url: string;
  }[];
}

interface SearchResponse {
  query: string;
  results: AggregatedResult[];
}

// Helper to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 3000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Search Bandcamp by scraping search results page (PRIMARY SOURCE)
async function searchBandcamp(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];
  const searchUrl = `https://bandcamp.com/search?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return results;

    const html = await response.text();
    const root = parse(html);
    const resultItems = root.querySelectorAll('.searchresult');

    for (let i = 0; i < Math.min(10, resultItems.length); i++) {
      const item = resultItems[i];
      const resultType = item.querySelector('.result-info .itemtype')?.textContent?.trim().toLowerCase();
      const heading = item.querySelector('.result-info .heading a');
      const name = heading?.textContent?.trim();
      const url = heading?.getAttribute('href')?.split('?')[0];

      const subhead = item.querySelector('.result-info .subhead')?.textContent?.trim();
      let artist: string | undefined;
      if (subhead && subhead.startsWith('by ')) {
        artist = subhead.substring(3).trim();
      }

      const img = item.querySelector('.art img');
      const imageUrl = img?.getAttribute('src');

      if (name && url) {
        let type: 'artist' | 'album' | 'track' = 'artist';
        if (resultType === 'album') type = 'album';
        else if (resultType === 'track') type = 'track';

        results.push({
          sourceId: 'bandcamp',
          name,
          artist,
          type,
          url,
          imageUrl: imageUrl || undefined,
        });
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Bandcamp search error:', error.message);
    }
  }

  return results;
}

// Search Bandwagon for artists by scraping search results
// Returns a map of normalized artist name -> direct Bandwagon artist URL
async function searchBandwagon(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const searchUrl = `https://bandwagon.fm/artists?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return results;

    const html = await response.text();
    const root = parse(html);
    const queryNormalized = normalizeForComparison(query);

    // Look for artist links in search results (Bandwagon uses /@{id} format)
    const artistLinks = root.querySelectorAll('a[href*="bandwagon.fm/@"]');
    const seen = new Set<string>();

    for (const link of artistLinks) {
      const href = link.getAttribute('href');
      // Get the artist name from the nested div with class "bold"
      const nameEl = link.querySelector('.bold');
      const name = nameEl?.textContent?.trim();

      if (href && name && !seen.has(href) && name.length > 0 && name.length < 100) {
        seen.add(href);
        const normalizedName = normalizeForComparison(name);

        // Check for exact or close match
        if (normalizedName === queryNormalized ||
            normalizedName.includes(queryNormalized) ||
            queryNormalized.includes(normalizedName)) {
          if (!results.has(normalizedName)) {
            results.set(normalizedName, href);
          }

          if (results.size >= 10) break;
        }
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Bandwagon search error:', error.message);
    }
  }

  return results;
}

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// MusicBrainz result interface for official website and Discogs lookup
interface MusicBrainzResult {
  artistName: string;
  officialUrl?: string;  // From "official homepage" relation
  discogsUrl?: string;   // From "discogs" relation
}

// Search MusicBrainz for artist info including official website and Discogs link
// Optimized: only 2 API calls (search + URL relations), skips release history check
async function searchMusicBrainz(query: string): Promise<MusicBrainzResult | null> {
  try {
    // Search for artist
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return null;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return null;

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) return null;

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await delay(1100);

    // Fetch artist details with URL relations
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let officialUrl: string | undefined;
    let discogsUrl: string | undefined;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: {
          type: string;
          url?: { resource: string };
        }[];
      };

      const relations = artistData.relations || [];

      // Look for official homepage
      for (const rel of relations) {
        if (rel.type === 'official homepage' && rel.url?.resource) {
          officialUrl = rel.url.resource;
          break;
        }
      }

      // Look for Discogs link
      for (const rel of relations) {
        if (rel.type === 'discogs' && rel.url?.resource) {
          discogsUrl = rel.url.resource;
          break;
        }
      }
    }

    return {
      artistName: artist.name,
      officialUrl,
      discogsUrl,
    };
  } catch (error: any) {
    console.error('MusicBrainz search error:', error.name, error.message);
    return null;
  }
}

// Search Mirlo by checking if artist page exists (Mirlo is client-side rendered)
async function searchMirlo(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  // Normalize query to URL-friendly format (lowercase, no spaces)
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '');
  const artistUrl = `https://mirlo.space/${normalizedQuery}`;

  try {
    const response = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return results;

    const html = await response.text();

    // Check if og:title matches the query (indicates artist exists)
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (ogTitleMatch) {
      const ogTitle = ogTitleMatch[1].toLowerCase();
      // If og:title is just "Mirlo", the artist doesn't exist
      if (ogTitle !== 'mirlo' && ogTitle.includes(normalizedQuery.substring(0, 4))) {
        // Get artist image if available
        const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
        const imageUrl = ogImageMatch ? ogImageMatch[1] : undefined;

        results.push({
          sourceId: 'mirlo',
          name: ogTitleMatch[1], // Use the actual title from the page
          type: 'artist',
          url: artistUrl,
          imageUrl,
        });
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Mirlo search error:', error.message);
    }
  }

  return results;
}

// Faircamp webring directory cache (refreshed every 10 minutes)
let faircampDirectoryCache: Record<string, { title: string; artists: string[]; description: string }> | null = null;
let faircampCacheTime = 0;
const FAIRCAMP_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getFaircampDirectory(): Promise<Record<string, { title: string; artists: string[]; description: string }>> {
  const now = Date.now();
  if (faircampDirectoryCache && (now - faircampCacheTime) < FAIRCAMP_CACHE_TTL) {
    return faircampDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://faircamp.webr.ing/directory.json', {}, 5000);
    if (!response.ok) {
      console.error('Faircamp directory fetch failed:', response.status);
      return faircampDirectoryCache || {};
    }
    faircampDirectoryCache = await response.json() as Record<string, { title: string; artists: string[]; description: string }>;
    faircampCacheTime = now;
    return faircampDirectoryCache;
  } catch (error: any) {
    console.error('Faircamp directory fetch error:', error.message);
    return faircampDirectoryCache || {};
  }
}

// Search Faircamp webring directory for artist matches
// Returns a map of normalized artist name -> faircamp URL
async function searchFaircamp(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const queryLower = query.toLowerCase();

  try {
    const directory = await getFaircampDirectory();

    for (const [domain, info] of Object.entries(directory)) {
      // Search through all artists for this site
      for (const artist of info.artists || []) {
        if (artist.toLowerCase().includes(queryLower) || queryLower.includes(artist.toLowerCase())) {
          // Store with normalized artist name as key
          const normalizedArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          results.set(normalizedArtist, `https://${domain}`);
        }
      }

      if (results.size >= 10) break; // Limit results
    }
  } catch (error: any) {
    console.error('Faircamp search error:', error.message);
  }

  return results;
}

function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Search Patreon API for creators matching the query
// Returns a map of normalized creator name -> Patreon URL
// Also indexes by URL slug to catch cases like "Mo-Rice" (URL: /Mo_Rice, campaign: "Mo-bility Station")
async function searchPatreon(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.patreon.com/api/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, 5000);

    if (!response.ok) {
      console.error('Patreon search failed:', response.status);
      return results;
    }

    const data = await response.json() as {
      data?: {
        type: string;
        attributes?: {
          creator_name?: string;
          url?: string;
        };
      }[];
    };

    const campaigns = data.data || [];

    for (const campaign of campaigns) {
      if (campaign.type === 'campaign-document' && campaign.attributes) {
        const creatorName = campaign.attributes.creator_name;
        const url = campaign.attributes.url;

        if (creatorName && url) {
          const normalizedName = normalizeForComparison(creatorName);
          // Only add if not already in results (first match wins)
          if (!results.has(normalizedName)) {
            results.set(normalizedName, url);
          }

          // Also index by URL slug (e.g., /Mo_Rice -> morice)
          // This catches cases where the campaign name differs from the artist name
          const urlSlug = url.split('/').pop();
          if (urlSlug) {
            const normalizedSlug = normalizeForComparison(urlSlug);
            if (!results.has(normalizedSlug)) {
              results.set(normalizedSlug, url);
            }
          }
        }
      }

      if (results.size >= 20) break;
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Patreon search error:', error.message);
    }
  }

  return results;
}

// Search Qobuz for artists by scraping search results
// Returns a map of normalized artist name -> direct Qobuz artist URL
async function searchQobuz(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.qobuz.com/us-en/search/artists/${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) {
      console.error('Qobuz search failed:', response.status);
      return results;
    }

    const html = await response.text();

    // Extract interpreter (artist) links: /us-en/interpreter/{slug}/{id}
    const interpreterRegex = /href="(\/us-en\/interpreter\/([^/]+)\/(\d+))"/g;
    let match;
    const queryNormalized = normalizeForComparison(query);

    while ((match = interpreterRegex.exec(html)) !== null && results.size < 10) {
      const [, path, slug] = match;
      const slugNormalized = slug.replace(/-/g, '');

      // Check if the slug closely matches the query
      if (slugNormalized === queryNormalized ||
          slugNormalized.includes(queryNormalized) ||
          queryNormalized.includes(slugNormalized)) {
        // Convert slug back to readable name (replace hyphens with spaces, capitalize)
        const artistName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const normalizedName = normalizeForComparison(artistName);

        if (!results.has(normalizedName)) {
          results.set(normalizedName, `https://www.qobuz.com${path}`);
        }
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Qobuz search error:', error.message);
    }
  }

  return results;
}

function generateResultId(name: string, artist?: string): string {
  const normalized = normalizeForComparison(artist ? `${artist}-${name}` : name);
  return normalized || Math.random().toString(36).substring(2);
}

function aggregateResults(allResults: PlatformResult[]): AggregatedResult[] {
  const resultMap = new Map<string, AggregatedResult>();

  for (const result of allResults) {
    // Skip "Search on X" placeholder results for aggregation
    if (result.name.startsWith('Search "')) continue;

    const key = generateResultId(result.name, result.artist);

    if (resultMap.has(key)) {
      const existing = resultMap.get(key)!;
      if (!existing.platforms.some(p => p.sourceId === result.sourceId)) {
        existing.platforms.push({
          sourceId: result.sourceId,
          url: result.url,
        });
      }
      if (!existing.imageUrl && result.imageUrl) {
        existing.imageUrl = result.imageUrl;
      }
    } else {
      resultMap.set(key, {
        id: key,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: result.imageUrl,
        platforms: [{
          sourceId: result.sourceId,
          url: result.url,
        }],
      });
    }
  }

  return Array.from(resultMap.values())
    .sort((a, b) => b.platforms.length - a.platforms.length);
}

async function searchAllPlatforms(query: string): Promise<AggregatedResult[]> {
  // Search all platforms in parallel with individual timeouts
  const [bandcampResults, bandwagonResults, mirloResults, faircampResults, patreonResults, qobuzResults, musicbrainzResult] = await Promise.allSettled([
    searchBandcamp(query),
    searchBandwagon(query),
    searchMirlo(query),
    searchFaircamp(query),
    searchPatreon(query),
    searchQobuz(query),
    searchMusicBrainz(query),
  ]);

  const allResults: PlatformResult[] = [];

  if (bandcampResults.status === 'fulfilled') {
    // Filter to only artist results
    allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  }
  if (mirloResults.status === 'fulfilled') {
    allResults.push(...mirloResults.value.filter(r => r.type === 'artist'));
  }

  // Extract MusicBrainz data (official URL and Discogs)
  const mbResult = musicbrainzResult.status === 'fulfilled' ? musicbrainzResult.value : null;

  // Get Bandwagon matches (returns Map of normalized artist name -> URL)
  const bandwagonMatches = bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map<string, string>();

  // Get Faircamp matches (returns Map of normalized artist name -> URL)
  const faircampMatches = faircampResults.status === 'fulfilled' ? faircampResults.value : new Map<string, string>();

  // Get Patreon matches (returns Map of normalized creator name -> URL)
  const patreonMatches = patreonResults.status === 'fulfilled' ? patreonResults.value : new Map<string, string>();

  // Get Qobuz matches (returns Map of normalized artist name -> URL)
  const qobuzMatches = qobuzResults.status === 'fulfilled' ? qobuzResults.value : new Map<string, string>();

  // Get aggregated results
  const aggregated = aggregateResults(allResults);

  // Add additional platforms to matching artist results
  for (const result of aggregated) {
    if (result.type === 'artist') {
      // Add search-only platform links for artists found on Bandcamp
      if (result.platforms.some(p => p.sourceId === 'bandcamp')) {
        // Ampwall
        result.platforms.push({
          sourceId: 'ampwall',
          url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(result.name)}`,
        });
        // Ko-fi (DuckDuckGo site search since Ko-fi has no native search)
        result.platforms.push({
          sourceId: 'kofi',
          url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(result.name)}`,
        });
      }

      const normalizedName = normalizeForComparison(result.name);

      // Add Bandwagon link if artist matches
      if (bandwagonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'bandwagon',
          url: bandwagonMatches.get(normalizedName)!,
        });
      }

      // Add Faircamp link if artist matches
      if (faircampMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'faircamp',
          url: faircampMatches.get(normalizedName)!,
        });
      }

      // Add Patreon link if artist matches
      if (patreonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'patreon',
          url: patreonMatches.get(normalizedName)!,
        });
      }

      // Add Qobuz link if artist matches
      if (qobuzMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'qobuz',
          url: qobuzMatches.get(normalizedName)!,
        });
      }

      // Add official website and Discogs if MusicBrainz found them and artist name matches
      if (mbResult?.officialUrl || mbResult?.discogsUrl) {
        const mbNormalizedName = normalizeForComparison(mbResult.artistName);
        if (normalizedName === mbNormalizedName ||
            normalizedName.includes(mbNormalizedName) ||
            mbNormalizedName.includes(normalizedName)) {
          // Add official site if available
          if (mbResult.officialUrl) {
            result.platforms.push({
              sourceId: 'officialsite',
              url: mbResult.officialUrl,
            });
          }
          // Add Discogs if available
          if (mbResult.discogsUrl) {
            result.platforms.push({
              sourceId: 'discogs',
              url: mbResult.discogsUrl,
            });
          }
        }
      }

      // Sort platforms: verified matches first, search-only platforms in middle, official/discogs last
      const searchOnlyPlatforms = new Set(['ampwall', 'kofi']);
      const officialPlatforms = new Set(['officialsite', 'discogs']);
      result.platforms.sort((a, b) => {
        // Official site/discogs always last (site before discogs)
        const aIsOfficial = officialPlatforms.has(a.sourceId);
        const bIsOfficial = officialPlatforms.has(b.sourceId);
        if (aIsOfficial && bIsOfficial) {
          // officialsite before discogs
          return a.sourceId === 'officialsite' ? -1 : 1;
        }
        if (aIsOfficial) return 1;
        if (bIsOfficial) return -1;
        // Search-only platforms after verified matches
        const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
        const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
        if (aIsSearchOnly && !bIsSearchOnly) return 1;
        if (!aIsSearchOnly && bIsSearchOnly) return -1;
        return 0;
      });
    }
  }

  return aggregated;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { query } = req.query;

  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Query parameter is required' });
    return;
  }

  try {
    const results = await searchAllPlatforms(query);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    const response: SearchResponse = {
      query,
      results,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Failed to search',
      query,
      results: [],
    });
  }
}
