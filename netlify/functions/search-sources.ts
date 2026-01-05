import { parse } from 'node-html-parser';

type SourceId =
  | 'bandcamp'
  | 'mirlo'
  | 'ampwall'
  | 'sonica'
  | 'bandwagon'
  | 'faircamp'
  | 'patreon'
  | 'buymeacoffee'
  | 'kofi'
  | 'hoopla'
  | 'freegal'
  | 'qobuz';

interface LatestRelease {
  title: string;
  type: 'album' | 'track';
  url: string;
  imageUrl?: string;
  releaseDate?: string; // ISO date or human-readable date string
}

interface PlatformResult {
  sourceId: SourceId;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  url: string;
  imageUrl?: string;
  latestRelease?: LatestRelease;
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
    latestRelease?: LatestRelease;
    allReleaseTitles?: string[]; // For disambiguation - all release titles (normalized)
  }[];
  // Match confidence: 'verified' means releases match across platforms,
  // 'unverified' means name-only match (no release data to compare)
  matchConfidence?: 'verified' | 'unverified';
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
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Bandcamp search error:', err.message);
    }
  }

  return results;
}

// Fetch latest release from a Bandcamp artist page, then get release date from album page
// Uses /music endpoint to get full discography (base URL may redirect to a single release)
async function getBandcampLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    // Extract base artist URL and append /music for full discography
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();
    const root = parse(html);

    // Find the first music grid item (most recent release)
    const musicGridItem = root.querySelector('.music-grid-item');
    if (!musicGridItem) return undefined;

    const link = musicGridItem.querySelector('a');
    const titleEl = musicGridItem.querySelector('.title');
    const artImg = musicGridItem.querySelector('img');

    if (!link || !titleEl) return undefined;

    const href = link.getAttribute('href');
    const title = titleEl.textContent?.trim();
    const imageUrl = artImg?.getAttribute('src') || artImg?.getAttribute('data-original');

    if (!href || !title) return undefined;

    // Determine if it's an album or track based on URL
    const type: 'album' | 'track' = href.includes('/track/') ? 'track' : 'album';

    // Build full URL if relative
    const fullUrl = href.startsWith('http') ? href : new URL(href, artistUrl).toString();

    // Fetch the album/track page to get release date
    let releaseDate: string | undefined;
    try {
      const albumResponse = await fetchWithTimeout(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 3000);

      if (albumResponse.ok) {
        const albumHtml = await albumResponse.text();
        // Look for release date in album-info or meta tags
        // Bandcamp format: "released December 6, 2024" or in JSON-LD
        const dateMatch = albumHtml.match(/released\s+(\w+\s+\d+,\s+\d{4})/i) ||
                          albumHtml.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})"/);
        if (dateMatch) {
          releaseDate = dateMatch[1];
        }
      }
    } catch {
      // Ignore errors fetching album page - we still have the release info
    }

    return {
      title,
      type,
      url: fullUrl,
      imageUrl: imageUrl || undefined,
      releaseDate,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Bandcamp latest release fetch error:', err.message);
    }
    return undefined;
  }
}

// Fetch all release titles from a Bandcamp artist page for disambiguation
async function getBandcampReleaseTitles(artistUrl: string): Promise<string[]> {
  try {
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return [];

    const html = await response.text();
    const root = parse(html);

    const titles: string[] = [];
    const musicGridItems = root.querySelectorAll('.music-grid-item');

    for (const item of musicGridItems) {
      const titleEl = item.querySelector('.title');
      const title = titleEl?.textContent?.trim();
      if (title) {
        titles.push(normalizeForComparison(title));
      }
      // Limit to first 20 releases for performance
      if (titles.length >= 20) break;
    }

    return titles;
  } catch {
    return [];
  }
}

// Fetch latest release from a Qobuz artist page
// Qobuz is client-side rendered, so we extract album info from URL patterns
// Adding sortBy parameter ensures we get releases sorted by date (most recent first)
async function getQobuzLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    // Extract artist name from URL for validation
    // URL format: /us-en/interpreter/{artist-slug}/{id}
    const artistSlugMatch = artistUrl.match(/\/interpreter\/([^/]+)\//);
    if (!artistSlugMatch) return undefined;
    const artistSlug = artistSlugMatch[1].replace(/-/g, '').toLowerCase();

    // Add sort parameter to get releases sorted by date (most recent first)
    const sortedUrl = artistUrl.includes('?')
      ? `${artistUrl}&%5BsortBy%5D=main_catalog_date_desc`
      : `${artistUrl}?%5BsortBy%5D=main_catalog_date_desc`;

    const response = await fetchWithTimeout(sortedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();

    // Qobuz album URLs are in format: /us-en/album/{album-name-slug}/{id}
    // Album IDs can be numeric or alphanumeric
    // Extract from the HTML using regex since page is client-rendered
    // Find ALL album URLs and pick the first one that belongs to this artist
    const albumRegex = /href="(\/us-en\/album\/([^/]+)\/([a-zA-Z0-9]+))"/g;
    let match;
    let validAlbum: { path: string; slug: string } | undefined;

    while ((match = albumRegex.exec(html)) !== null) {
      const [, path, albumSlug] = match;
      const normalizedSlug = albumSlug.replace(/-/g, '').toLowerCase();

      // Validate: album slug should contain the artist name
      // This filters out "trending" or "recommended" albums shown on empty artist pages
      // Artist slug without numbers for matching (e.g., "morice1" -> "morice")
      const artistBase = artistSlug.replace(/\d+$/, '');
      if (normalizedSlug.includes(artistBase) || normalizedSlug.includes(artistSlug)) {
        validAlbum = { path, slug: albumSlug };
        break;
      }
    }

    if (!validAlbum) return undefined;

    // Convert slug to readable title (replace hyphens with spaces, title case)
    const title = validAlbum.slug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    // Build full URL
    const fullUrl = `https://www.qobuz.com${validAlbum.path}`;

    // Try to extract release date from the page
    let releaseDate: string | undefined;
    // Look for date patterns in the HTML
    const dateMatch = html.match(/"releaseDate"[:\s]*"(\d{4}-\d{2}-\d{2})"/) ||
                      html.match(/(\d{4}-\d{2}-\d{2})/) ||
                      html.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
    if (dateMatch) {
      releaseDate = dateMatch[1];
    }

    return {
      title,
      type: 'album',
      url: fullUrl,
      imageUrl: undefined, // Qobuz images require JS rendering
      releaseDate,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Qobuz latest release fetch error:', err.message);
    }
    return undefined;
  }
}

// Fetch all release titles from a Qobuz artist page for disambiguation
async function getQobuzReleaseTitles(artistUrl: string): Promise<string[]> {
  try {
    // Extract artist name from URL for validation
    const artistSlugMatch = artistUrl.match(/\/interpreter\/([^/]+)\//);
    if (!artistSlugMatch) return [];
    const artistSlug = artistSlugMatch[1].replace(/-/g, '').toLowerCase();
    const artistBase = artistSlug.replace(/\d+$/, ''); // Remove trailing numbers

    const response = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return [];

    const html = await response.text();
    const titles: string[] = [];

    // Extract all album slugs from the page
    // Qobuz album URLs: /us-en/album/{album-name-slug}/{id}
    const albumRegex = /href="\/us-en\/album\/([^/]+)\/[a-zA-Z0-9]+"/g;
    let match;
    const seen = new Set<string>();

    while ((match = albumRegex.exec(html)) !== null && titles.length < 20) {
      const slug = match[1];
      if (seen.has(slug)) continue;
      seen.add(slug);

      // Convert slug to normalized title (remove hyphens, lowercase)
      const normalized = slug.replace(/-/g, '').toLowerCase();

      // Validate: album slug should contain the artist name
      // This filters out "trending" or "recommended" albums shown on empty artist pages
      if (!normalized.includes(artistBase) && !normalized.includes(artistSlug)) {
        continue; // Skip albums that don't belong to this artist
      }

      titles.push(normalized);
    }

    return titles;
  } catch {
    return [];
  }
}

function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Search Bandwagon for artists by scraping search results
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

    const artistLinks = root.querySelectorAll('a[href*="bandwagon.fm/@"]');
    const seen = new Set<string>();

    for (const link of artistLinks) {
      const href = link.getAttribute('href');
      const nameEl = link.querySelector('.bold');
      const name = nameEl?.textContent?.trim();

      if (href && name && !seen.has(href) && name.length > 0 && name.length < 100) {
        seen.add(href);
        const normalizedName = normalizeForComparison(name);

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
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Bandwagon search error:', err.message);
    }
  }

  return results;
}

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Search MusicBrainz for major artists and return results with Hoopla if they have pre-2005 releases
async function searchMusicBrainz(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  try {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) return results;

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return results;

    const artist = artists[0];
    if (artist.score < 95) return results;

    await delay(1100);

    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!releasesResponse.ok) return results;

    const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
    const releaseGroups = releasesData['release-groups'] || [];

    for (const rg of releaseGroups) {
      const firstReleaseDate = rg['first-release-date'];
      if (firstReleaseDate) {
        const year = parseInt(firstReleaseDate.substring(0, 4), 10);
        if (year < 2005) {
          console.log('Adding Hoopla and Freegal for:', artist.name);
          // Add Hoopla search link
          const hooplaSearchUrl = `https://www.hoopladigital.com/search?q=${encodeURIComponent(artist.name)}&type=music`;
          results.push({
            sourceId: 'hoopla',
            name: artist.name,
            type: 'artist',
            url: hooplaSearchUrl,
          });
          // Add Freegal direct artist link (Base64-encoded artist name)
          const freegalArtistId = Buffer.from(artist.name).toString('base64');
          results.push({
            sourceId: 'freegal',
            name: artist.name,
            type: 'artist',
            url: `https://www.freegalmusic.com/artist/${freegalArtistId}`,
          });
          break;
        }
      }
    }
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
  }

  return results;
}

// Search Mirlo by checking if artist page exists
async function searchMirlo(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];
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
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (ogTitleMatch) {
      const ogTitle = ogTitleMatch[1].toLowerCase();
      if (ogTitle !== 'mirlo' && ogTitle.includes(normalizedQuery.substring(0, 4))) {
        const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
        const imageUrl = ogImageMatch ? ogImageMatch[1] : undefined;

        results.push({
          sourceId: 'mirlo',
          name: ogTitleMatch[1],
          type: 'artist',
          url: artistUrl,
          imageUrl,
        });
      }
    }
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Mirlo search error:', err.message);
    }
  }

  return results;
}

// Faircamp webring directory cache
let faircampDirectoryCache: Record<string, { title: string; artists: string[]; description: string }> | null = null;
let faircampCacheTime = 0;
const FAIRCAMP_CACHE_TTL = 10 * 60 * 1000;

async function getFaircampDirectory(): Promise<Record<string, { title: string; artists: string[]; description: string }>> {
  const now = Date.now();
  if (faircampDirectoryCache && (now - faircampCacheTime) < FAIRCAMP_CACHE_TTL) {
    return faircampDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://faircamp.webr.ing/directory.json', {}, 5000);
    if (!response.ok) {
      return faircampDirectoryCache || {};
    }
    faircampDirectoryCache = await response.json() as Record<string, { title: string; artists: string[]; description: string }>;
    faircampCacheTime = now;
    return faircampDirectoryCache;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Faircamp directory fetch error:', err.message);
    return faircampDirectoryCache || {};
  }
}

async function searchFaircamp(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const queryLower = query.toLowerCase();

  try {
    const directory = await getFaircampDirectory();

    for (const [domain, info] of Object.entries(directory)) {
      for (const artist of info.artists || []) {
        if (artist.toLowerCase().includes(queryLower) || queryLower.includes(artist.toLowerCase())) {
          const normalizedArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          results.set(normalizedArtist, `https://${domain}`);
        }
      }
      if (results.size >= 10) break;
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Faircamp search error:', err.message);
  }

  return results;
}

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

    if (!response.ok) return results;

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
          if (!results.has(normalizedName)) {
            results.set(normalizedName, url);
          }
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
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Patreon search error:', err.message);
    }
  }

  return results;
}

async function searchQobuz(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.qobuz.com/us-en/search/artists/${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return results;

    const html = await response.text();
    const interpreterRegex = /href="(\/us-en\/interpreter\/([^/]+)\/(\d+))"/g;
    let match;
    const queryNormalized = normalizeForComparison(query);

    while ((match = interpreterRegex.exec(html)) !== null && results.size < 10) {
      const [, path, slug] = match;
      const slugNormalized = slug.replace(/-/g, '');

      // Strict matching: only allow exact match, query prefix, or numeric suffix variations
      // This prevents "Mo-Rice" from matching "Morice El Blanco" or "Patrick Moriceau"
      const isMatch = slugNormalized === queryNormalized ||
          // Query is longer than slug (e.g., searching "morice" matches slug "mo")
          queryNormalized.startsWith(slugNormalized) ||
          // Slug is query + numeric suffix only (e.g., "morice" matches "morice2" but not "moriceelblanco")
          (slugNormalized.startsWith(queryNormalized) && /^\d*$/.test(slugNormalized.slice(queryNormalized.length)));

      if (isMatch) {
        const artistName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const normalizedName = normalizeForComparison(artistName);

        if (!results.has(normalizedName)) {
          results.set(normalizedName, `https://www.qobuz.com${path}`);
        }
      }
    }
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Qobuz search error:', err.message);
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
  const [bandcampResults, bandwagonResults, mirloResults, faircampResults, patreonResults, qobuzResults, musicbrainzResults] = await Promise.allSettled([
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
    allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  }
  if (mirloResults.status === 'fulfilled') {
    allResults.push(...mirloResults.value.filter(r => r.type === 'artist'));
  }
  if (musicbrainzResults.status === 'fulfilled') {
    allResults.push(...musicbrainzResults.value.filter(r => r.type === 'artist'));
  }

  const bandwagonMatches = bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map<string, string>();
  const faircampMatches = faircampResults.status === 'fulfilled' ? faircampResults.value : new Map<string, string>();
  const patreonMatches = patreonResults.status === 'fulfilled' ? patreonResults.value : new Map<string, string>();
  const qobuzMatches = qobuzResults.status === 'fulfilled' ? qobuzResults.value : new Map<string, string>();

  const aggregated = aggregateResults(allResults);

  for (const result of aggregated) {
    if (result.type === 'artist') {
      if (result.platforms.some(p => p.sourceId === 'bandcamp')) {
        result.platforms.push({
          sourceId: 'ampwall',
          url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(result.name)}`,
        });
        result.platforms.push({
          sourceId: 'kofi',
          url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(result.name)}`,
        });
        result.platforms.push({
          sourceId: 'buymeacoffee',
          url: 'https://buymeacoffee.com/explore-creators',
        });
        result.platforms.push({
          sourceId: 'sonica',
          url: `https://sonica.music/search/${encodeURIComponent(result.name)}`,
        });
      }

      const normalizedName = normalizeForComparison(result.name);

      if (bandwagonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'bandwagon',
          url: bandwagonMatches.get(normalizedName)!,
        });
      }

      if (faircampMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'faircamp',
          url: faircampMatches.get(normalizedName)!,
        });
      }

      if (patreonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'patreon',
          url: patreonMatches.get(normalizedName)!,
        });
      }

      // Check for Qobuz matches - add ALL variations with numeric suffixes
      // (e.g., "morice" should match "morice", "morice1", "morice2")
      // We add all of them and let disambiguation sort out which ones match based on releases
      for (const [qobuzName, qobuzUrl] of qobuzMatches) {
        // Match if exact, or if qobuz name is base name + numbers
        const isVariation = qobuzName === normalizedName ||
            (qobuzName.startsWith(normalizedName) && /^\d+$/.test(qobuzName.slice(normalizedName.length)));
        if (isVariation) {
          result.platforms.push({
            sourceId: 'qobuz',
            url: qobuzUrl,
          });
        }
      }

      const searchOnlyPlatforms = new Set(['ampwall', 'sonica', 'kofi', 'buymeacoffee']);
      result.platforms.sort((a, b) => {
        const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
        const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
        if (aIsSearchOnly && !bIsSearchOnly) return 1;
        if (!aIsSearchOnly && bIsSearchOnly) return -1;
        return 0;
      });
    }
  }

  // Track which platform matches were used so we can create entries for unmatched ones
  const usedQobuzMatches = new Set<string>();
  const usedPatreonMatches = new Set<string>();
  const usedBandwagonMatches = new Set<string>();
  const usedFaircampMatches = new Set<string>();

  // Track base names of aggregated results for variation matching
  const aggregatedBaseNames = new Set<string>();
  for (const result of aggregated) {
    const normalizedName = normalizeForComparison(result.name);
    aggregatedBaseNames.add(normalizedName);

    // Check for exact matches and variations
    for (const [qobuzName] of qobuzMatches) {
      const isVariation = qobuzName === normalizedName ||
          (qobuzName.startsWith(normalizedName) && /^\d+$/.test(qobuzName.slice(normalizedName.length)));
      if (isVariation) usedQobuzMatches.add(qobuzName);
    }
    if (patreonMatches.has(normalizedName)) usedPatreonMatches.add(normalizedName);
    if (bandwagonMatches.has(normalizedName)) usedBandwagonMatches.add(normalizedName);
    if (faircampMatches.has(normalizedName)) usedFaircampMatches.add(normalizedName);
  }

  // Create new results for Qobuz matches that weren't added to existing results
  // This handles artists who are on Qobuz but not on Bandcamp/Mirlo
  for (const [normalizedName, url] of qobuzMatches) {
    // Skip if already used OR if this is a variation of an existing result
    const baseNameWithoutNumbers = normalizedName.replace(/\d+$/, '');
    const isVariationOfExisting = aggregatedBaseNames.has(baseNameWithoutNumbers);
    if (usedQobuzMatches.has(normalizedName) || isVariationOfExisting) {
      continue;
    }

    // Extract display name from URL slug
    const slugMatch = url.match(/\/interpreter\/([^/]+)\//);
    const displayName = slugMatch
      ? slugMatch[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : normalizedName;

    const newResult: AggregatedResult = {
      id: `qobuz-${normalizedName}`,
      name: displayName,
      type: 'artist',
      platforms: [
        { sourceId: 'qobuz', url },
        // Add search-only platforms for this artist
        { sourceId: 'ampwall', url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(displayName)}` },
        { sourceId: 'sonica', url: `https://sonica.music/search/${encodeURIComponent(displayName)}` },
        { sourceId: 'kofi', url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(displayName)}` },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
      ],
    };

    // Check if this Qobuz artist also has matches on other platforms
    if (patreonMatches.has(normalizedName) && !usedPatreonMatches.has(normalizedName)) {
      newResult.platforms.splice(1, 0, { sourceId: 'patreon', url: patreonMatches.get(normalizedName)! });
      usedPatreonMatches.add(normalizedName);
    }
    if (bandwagonMatches.has(normalizedName) && !usedBandwagonMatches.has(normalizedName)) {
      newResult.platforms.splice(1, 0, { sourceId: 'bandwagon', url: bandwagonMatches.get(normalizedName)! });
      usedBandwagonMatches.add(normalizedName);
    }
    if (faircampMatches.has(normalizedName) && !usedFaircampMatches.has(normalizedName)) {
      newResult.platforms.splice(1, 0, { sourceId: 'faircamp', url: faircampMatches.get(normalizedName)! });
      usedFaircampMatches.add(normalizedName);
    }

    aggregated.push(newResult);
    console.log(`[Qobuz-only] Created result for "${displayName}" from Qobuz match`);
  }

  // Fetch latest releases AND all release titles for Bandcamp and Qobuz artist pages in parallel
  const releasePromises: Promise<void>[] = [];
  for (const result of aggregated) {
    if (result.type === 'artist') {
      const bandcampPlatform = result.platforms.find(p => p.sourceId === 'bandcamp');
      if (bandcampPlatform) {
        // Fetch latest release for display
        releasePromises.push(
          getBandcampLatestRelease(bandcampPlatform.url).then(release => {
            if (release) {
              bandcampPlatform.latestRelease = release;
            }
          })
        );
        // Fetch all release titles for disambiguation
        releasePromises.push(
          getBandcampReleaseTitles(bandcampPlatform.url).then(titles => {
            if (titles.length > 0) {
              bandcampPlatform.allReleaseTitles = titles;
            }
          })
        );
      }

      const qobuzPlatform = result.platforms.find(p => p.sourceId === 'qobuz');
      if (qobuzPlatform) {
        // Fetch latest release for display
        releasePromises.push(
          getQobuzLatestRelease(qobuzPlatform.url).then(release => {
            if (release) {
              qobuzPlatform.latestRelease = release;
            }
          })
        );
        // Fetch all release titles for disambiguation
        releasePromises.push(
          getQobuzReleaseTitles(qobuzPlatform.url).then(titles => {
            if (titles.length > 0) {
              qobuzPlatform.allReleaseTitles = titles;
            }
          })
        );
      }
    }
  }

  // Wait for all release fetches with a timeout
  await Promise.race([
    Promise.allSettled(releasePromises),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);

  // Clean up dead Qobuz links: remove Qobuz platforms that have no releases
  // These are placeholder/redirect pages that have no actual content
  for (const result of aggregated) {
    const validQobuzPlatforms = result.platforms.filter(p => {
      if (p.sourceId !== 'qobuz') return true; // Keep non-Qobuz platforms
      // Keep Qobuz if it has releases, remove if empty (dead link)
      const hasReleases = p.latestRelease || (p.allReleaseTitles && p.allReleaseTitles.length > 0);
      if (!hasReleases) {
        console.log(`[Cleanup] Removing dead Qobuz link for "${result.name}": ${p.url}`);
      }
      return hasReleases;
    });
    result.platforms = validQobuzPlatforms;
  }

  // Disambiguate artists by comparing releases across platforms
  // If releases don't match, split into separate results
  const disambiguated: AggregatedResult[] = [];

  // Platforms where "no releases" is reliable evidence of a different artist
  // Bandcamp: we scrape HTML directly, very reliable
  // Qobuz: client-side rendered, fetch failures common - don't treat as suspicious
  const platformsWithReliableReleaseFetching = new Set(['bandcamp']);

  for (const result of aggregated) {
    const platformsWithReleases = result.platforms.filter(p => p.latestRelease);
    const platformsWithoutReleases = result.platforms.filter(p => !p.latestRelease);

    // Check for suspicious cases: platforms where we fetched releases but found none
    // (e.g., a Bandcamp page with no music is likely not the real artist)
    const suspiciousPlatforms = platformsWithoutReleases.filter(
      p => platformsWithReliableReleaseFetching.has(p.sourceId)
    );

    // If no platforms have releases, mark as unverified and keep as-is
    if (platformsWithReleases.length === 0) {
      result.matchConfidence = 'unverified';
      disambiguated.push(result);
      continue;
    }

    // If we have releases from some platforms, but Bandcamp specifically has no releases,
    // split Bandcamp out as unverified (Bandcamp scraping is reliable, so empty = suspicious)
    // Qobuz without releases is NOT suspicious (client-rendered, fetch failures common)
    if (suspiciousPlatforms.length > 0 && platformsWithReleases.length > 0) {
      console.log(`[Disambiguation] Splitting "${result.name}": ${suspiciousPlatforms.map(p => p.sourceId).join(', ')} have no releases`);

      // Create main verified result with platforms that have releases + non-suspicious platforms
      const verifiedImageUrl = platformsWithReleases.find(p => p.latestRelease?.imageUrl)?.latestRelease?.imageUrl;
      const verifiedResult: AggregatedResult = {
        id: result.id,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: verifiedImageUrl || result.imageUrl,
        platforms: [...platformsWithReleases, ...platformsWithoutReleases.filter(p => !platformsWithReliableReleaseFetching.has(p.sourceId))],
        matchConfidence: 'verified',
      };
      disambiguated.push(verifiedResult);

      // Create separate unverified results for suspicious platforms (Bandcamp with no releases)
      for (const platform of suspiciousPlatforms) {
        const unverifiedResult: AggregatedResult = {
          id: `${result.id}-${platform.sourceId}`,
          name: result.name,
          artist: result.artist,
          type: result.type,
          imageUrl: result.imageUrl,
          platforms: [platform],
          matchConfidence: 'unverified',
        };
        disambiguated.push(unverifiedResult);
      }
      continue;
    }

    // If only one platform has releases and no suspicious platforms, keep as verified
    if (platformsWithReleases.length === 1) {
      result.matchConfidence = 'verified';
      disambiguated.push(result);
      continue;
    }

    // Multiple platforms have releases - check if ANY release title matches across platforms
    // This is the key fix: we compare ALL releases, not just the "latest" one
    const platformsWithTitles = platformsWithReleases.filter(p =>
      p.allReleaseTitles && p.allReleaseTitles.length > 0
    );

    // Helper to check if two platforms share any release title
    const hasMatchingRelease = (titles1: string[], titles2: string[]): boolean => {
      for (const t1 of titles1) {
        for (const t2 of titles2) {
          // Check for exact match or partial match (one contains the other)
          if (t1 === t2 ||
              (t1.length > 5 && t2.length > 5 && (t1.includes(t2) || t2.includes(t1)))) {
            return true;
          }
        }
      }
      return false;
    };

    // If we have release titles from multiple platforms, check for matches
    if (platformsWithTitles.length >= 2) {
      // Check if there's at least one matching release between any two platforms
      let foundMatch = false;
      for (let i = 0; i < platformsWithTitles.length && !foundMatch; i++) {
        for (let j = i + 1; j < platformsWithTitles.length && !foundMatch; j++) {
          if (hasMatchingRelease(
            platformsWithTitles[i].allReleaseTitles!,
            platformsWithTitles[j].allReleaseTitles!
          )) {
            foundMatch = true;
            console.log(`[Disambiguation] "${result.name}": Found matching release between ${platformsWithTitles[i].sourceId} and ${platformsWithTitles[j].sourceId}`);
          }
        }
      }

      if (foundMatch) {
        // At least one release matches - this is the same artist
        result.matchConfidence = 'verified';
        disambiguated.push(result);
        continue;
      }
    }

    // Fallback: compare just the latest release titles (for platforms without allReleaseTitles)
    const releaseGroups = new Map<string, typeof result.platforms>();

    for (const platform of platformsWithReleases) {
      const normalizedTitle = normalizeForComparison(platform.latestRelease?.title || '');

      // Find an existing group with a matching release
      let foundGroup = false;
      for (const [groupTitle, groupPlatforms] of releaseGroups) {
        // Check if titles match (allowing partial matches for similar releases)
        if (normalizedTitle === groupTitle ||
            normalizedTitle.includes(groupTitle) ||
            groupTitle.includes(normalizedTitle) ||
            (normalizedTitle.length > 5 && groupTitle.length > 5 &&
             (normalizedTitle.substring(0, 5) === groupTitle.substring(0, 5)))) {
          groupPlatforms.push(platform);
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup) {
        releaseGroups.set(normalizedTitle, [platform]);
      }
    }

    // If all releases match (single group), keep as verified single result
    if (releaseGroups.size === 1) {
      result.matchConfidence = 'verified';
      disambiguated.push(result);
      continue;
    }

    // Multiple release groups with no matching titles = different artists with same name
    // Split into separate results
    console.log(`[Disambiguation] Splitting "${result.name}" into ${releaseGroups.size} separate artists based on different releases`);

    let groupIndex = 0;
    for (const [, groupPlatforms] of releaseGroups) {
      groupIndex++;

      // Get the primary platform (prefer Bandcamp, then Qobuz)
      const primaryPlatform = groupPlatforms.find(p => p.sourceId === 'bandcamp') ||
                              groupPlatforms.find(p => p.sourceId === 'qobuz') ||
                              groupPlatforms[0];

      // Create a new result for this group
      const newResult: AggregatedResult = {
        id: `${result.id}-${groupIndex}`,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: groupPlatforms.find(p => p.latestRelease?.imageUrl)?.latestRelease?.imageUrl || result.imageUrl,
        platforms: [...groupPlatforms],
        matchConfidence: 'verified',
      };

      disambiguated.push(newResult);
    }

    // Platforms without releases go into their own "unverified" group
    // if there are any remaining
    if (platformsWithoutReleases.length > 0) {
      const unverifiedResult: AggregatedResult = {
        id: `${result.id}-unverified`,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: result.imageUrl,
        platforms: platformsWithoutReleases,
        matchConfidence: 'unverified',
      };
      disambiguated.push(unverifiedResult);
    }
  }

  // Filter out results that only have search-only platforms (ampwall, kofi, buymeacoffee)
  // These are just fuzzy search links added to any Bandcamp result, not real matches
  const searchOnlyPlatforms = new Set(['ampwall', 'kofi', 'buymeacoffee']);
  const filtered = disambiguated.filter(result => {
    const hasNonSearchOnlyPlatform = result.platforms.some(p => !searchOnlyPlatforms.has(p.sourceId));
    return hasNonSearchOnlyPlatform;
  });

  // Sort results: verified first, then by platform count
  filtered.sort((a, b) => {
    if (a.matchConfidence === 'verified' && b.matchConfidence !== 'verified') return -1;
    if (a.matchConfidence !== 'verified' && b.matchConfidence === 'verified') return 1;
    return b.platforms.length - a.platforms.length;
  });

  return filtered;
}

// Search a Bandcamp artist page for a specific album title
// Uses /music endpoint to access full discography (base URL may redirect to a single release)
async function searchBandcampForAlbum(artistUrl: string, albumTitle: string): Promise<string | undefined> {
  try {
    // Extract base artist URL and append /music for full discography
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();
    const root = parse(html);
    const normalizedSearchTitle = normalizeForComparison(albumTitle);

    // Look through all music grid items for matching title
    const musicGridItems = root.querySelectorAll('.music-grid-item');
    for (const item of musicGridItems) {
      const titleEl = item.querySelector('.title');
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      const normalizedTitle = normalizeForComparison(title);
      // Check for match (allowing partial matches for long titles)
      if (normalizedTitle === normalizedSearchTitle ||
          normalizedTitle.includes(normalizedSearchTitle) ||
          normalizedSearchTitle.includes(normalizedTitle)) {
        const link = item.querySelector('a');
        const href = link?.getAttribute('href');
        if (href) {
          return href.startsWith('http') ? href : new URL(href, artistUrl).toString();
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Parse various date formats into a Date object
function parseReleaseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;

  // Try ISO format: 2024-12-06
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // Try "Month Day, Year" format: December 6, 2024
  const monthDayYear = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    const monthIndex = new Date(`${month} 1, 2000`).getMonth();
    if (!isNaN(monthIndex)) {
      return new Date(parseInt(year), monthIndex, parseInt(day));
    }
  }

  // Try "MM/DD/YYYY" or "DD/MM/YYYY" format (assume MM/DD/YYYY for US)
  const slashDate = dateStr.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (slashDate) {
    const [, first, second, year] = slashDate;
    // Assume MM/DD/YYYY
    return new Date(parseInt(year), parseInt(first) - 1, parseInt(second));
  }

  return undefined;
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const query = event.queryStringParameters?.query;

  if (!query) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Query parameter is required' }),
    };
  }

  try {
    const results = await searchAllPlatforms(query);

    const response: SearchResponse = {
      query,
      results,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate',
      },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error('Search error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'Failed to search',
        query,
        results: [],
      }),
    };
  }
}
