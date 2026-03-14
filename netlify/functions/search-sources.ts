import { parse } from 'node-html-parser';
import { cacheGetOrFetch, artistCacheKey } from './cache';
import { persistSearchResults, getArtistBySlug, artistSlug } from './db';

type SourceId =
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
  // 'claimed' means artist has verified ownership of this profile
  matchConfidence?: 'verified' | 'unverified' | 'claimed';
  // Slug for claimed artist page (/a/{slug})
  claimedSlug?: string;
}

interface SearchResponse {
  query: string;
  results: AggregatedResult[];
  hasPendingEnrichment?: boolean;
}

// Normalize accented characters to their ASCII equivalents
// e.g., "Tanerélle" -> "Tanerelle", "Björk" -> "Bjork"
function normalizeAccents(str: string): string {
  // Unicode NFD normalization decomposes accented characters
  // e.g., "é" becomes "e" + combining acute accent
  // Then we remove the combining diacritical marks (U+0300 to U+036F)
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normalize a search query for API calls
// Removes accents but preserves spaces and basic punctuation
function normalizeSearchQuery(query: string): string {
  return normalizeAccents(query);
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

// Check if two names are similar enough to be considered a match
// Returns true if names match closely (same name, or one contains the other)
function namesMatch(name1: string, name2: string): boolean {
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

// Cache TTL for platform searches (30 minutes)
const PLATFORM_CACHE_TTL = 30 * 60;

// Search Bandcamp by scraping search results page (PRIMARY SOURCE)
async function searchBandcamp(query: string): Promise<PlatformResult[]> {
  const cacheKey = artistCacheKey('bandcamp', query);

  const { data } = await cacheGetOrFetch<PlatformResult[]>(
    cacheKey,
    async () => {
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

            // Filter: only include results where name matches the query
            // This filters out Bandcamp's fuzzy matches (e.g., "Dory Miller" for "Cory Miller")
            const nameToCheck = type === 'artist' ? name : (artist || name);
            if (!namesMatch(nameToCheck, query)) {
              console.log(`[Bandcamp] Filtering out fuzzy match: "${nameToCheck}" doesn't match query "${query}"`);
              continue;
            }

            // Filter out fan profiles: bandcamp.com/username (path-based)
            // Only keep artist pages: artist.bandcamp.com (subdomain-based)
            try {
              const parsedUrl = new URL(url);
              if (parsedUrl.hostname === 'bandcamp.com') {
                console.log(`[Bandcamp] Filtering out fan profile: "${name}" at ${url}`);
                continue;
              }
            } catch { /* invalid URL, skip */ }

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
    },
    PLATFORM_CACHE_TTL
  );

  return data;
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

// Fetch release date from a Qobuz album page
async function getQobuzAlbumReleaseDate(albumUrl: string): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(albumUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 2000);

    if (!response.ok) return undefined;

    const html = await response.text();

    // Look for release date in various formats
    // Qobuz often has it in JSON-LD or meta tags
    const dateMatch = html.match(/"releaseDate"[:\s]*"(\d{4}-\d{2}-\d{2})"/) ||
                      html.match(/"release_date_original"[:\s]*"(\d{4}-\d{2}-\d{2})"/) ||
                      html.match(/Release date[:\s]*<[^>]*>(\d{4}-\d{2}-\d{2})/i) ||
                      html.match(/Released[:\s]*(\d{4}-\d{2}-\d{2})/i);

    if (dateMatch) {
      return dateMatch[1];
    }

    // Try to find year at least
    const yearMatch = html.match(/"release_date_original"[:\s]*"(\d{4})/) ||
                      html.match(/Released[:\s]*(\d{4})/i);
    if (yearMatch) {
      return `${yearMatch[1]}-01-01`; // Use Jan 1 as placeholder
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Fetch latest release from a Qobuz artist page
// Qobuz is client-side rendered, so we extract album info from URL patterns
// We collect all albums and fetch their dates to find the chronologically most recent
async function getQobuzLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    // Extract artist name from URL for validation
    // URL format: /us-en/interpreter/{artist-slug}/{id}
    const artistSlugMatch = artistUrl.match(/\/interpreter\/([^/]+)\//);
    if (!artistSlugMatch) return undefined;
    const artistSlug = artistSlugMatch[1].replace(/-/g, '').toLowerCase();

    const response = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();

    // Qobuz album URLs are in format: /us-en/album/{album-name-slug}/{id}
    // Album IDs can be numeric or alphanumeric
    // Collect ALL valid albums from this artist
    const albumRegex = /href="(\/us-en\/album\/([^/]+)\/([a-zA-Z0-9]+))"/g;
    let match;
    const validAlbums: { path: string; slug: string; id: string }[] = [];
    const seenPaths = new Set<string>();

    // Artist slug without numbers for matching (e.g., "morice1" -> "morice")
    const artistBase = artistSlug.replace(/\d+$/, '');

    while ((match = albumRegex.exec(html)) !== null) {
      const [, path, albumSlug, albumId] = match;

      // Skip duplicates
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);

      const normalizedSlug = albumSlug.replace(/-/g, '').toLowerCase();

      // Validate: album slug should contain the artist name
      // This filters out "trending" or "recommended" albums shown on empty artist pages
      if (normalizedSlug.includes(artistBase) || normalizedSlug.includes(artistSlug)) {
        validAlbums.push({ path, slug: albumSlug, id: albumId });
      }

      // Limit to first 10 albums to avoid too many requests
      if (validAlbums.length >= 10) break;
    }

    if (validAlbums.length === 0) return undefined;

    // If only one album, just return it
    if (validAlbums.length === 1) {
      const album = validAlbums[0];
      const fullUrl = `https://www.qobuz.com${album.path}`;
      const releaseDate = await getQobuzAlbumReleaseDate(fullUrl);

      return {
        title: album.slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
        type: 'album',
        url: fullUrl,
        imageUrl: undefined,
        releaseDate,
      };
    }

    // Fetch release dates for all albums in parallel (limit to 5 to be respectful)
    const albumsToCheck = validAlbums.slice(0, 5);
    const datePromises = albumsToCheck.map(async (album) => {
      const fullUrl = `https://www.qobuz.com${album.path}`;
      const releaseDate = await getQobuzAlbumReleaseDate(fullUrl);
      return { album, fullUrl, releaseDate };
    });

    const results = await Promise.allSettled(datePromises);

    // Find the album with the most recent release date
    let latestAlbum: { album: typeof validAlbums[0]; fullUrl: string; releaseDate?: string } | undefined;
    let latestDate: Date | undefined;

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { album, fullUrl, releaseDate } = result.value;

      if (releaseDate) {
        const date = new Date(releaseDate);
        if (!isNaN(date.getTime())) {
          if (!latestDate || date > latestDate) {
            latestDate = date;
            latestAlbum = { album, fullUrl, releaseDate };
          }
        }
      } else if (!latestAlbum) {
        // Keep first album as fallback if no dates found
        latestAlbum = { album, fullUrl, releaseDate: undefined };
      }
    }

    if (!latestAlbum) {
      // Fallback to first album if all date fetches failed
      const album = validAlbums[0];
      return {
        title: album.slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
        type: 'album',
        url: `https://www.qobuz.com${album.path}`,
        imageUrl: undefined,
        releaseDate: undefined,
      };
    }

    return {
      title: latestAlbum.album.slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
      type: 'album',
      url: latestAlbum.fullUrl,
      imageUrl: undefined,
      releaseDate: latestAlbum.releaseDate,
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
      let normalized = slug.replace(/-/g, '').toLowerCase();

      // Validate: album slug should contain the artist name
      // This filters out "trending" or "recommended" albums shown on empty artist pages
      if (!normalized.includes(artistBase) && !normalized.includes(artistSlug)) {
        continue; // Skip albums that don't belong to this artist
      }

      // Strip artist name from the title for better cross-platform matching
      // Qobuz slugs are like "ruined-castle-kid-lightbulbs" but Bandcamp titles are just "ruinedcastle"
      normalized = normalized.replace(artistSlug, '').replace(artistBase, '');

      titles.push(normalized);
    }

    return titles;
  } catch {
    return [];
  }
}

function normalizeForComparison(str: string): string {
  // First normalize accents, then lowercase and remove non-alphanumeric
  return normalizeAccents(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function textMatchScore(name: string, query: string): number {
  const normName = normalizeForComparison(name);
  const normQuery = normalizeForComparison(query);
  if (normName === normQuery) return 3;
  if (normName.startsWith(normQuery)) return 2;
  if (normName.includes(normQuery)) return 1;
  return 0;
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

// MusicBrainz result interface for official website and Discogs lookup
interface MusicBrainzResult {
  artistName: string;
  officialUrl?: string;  // From "official homepage" relation
  discogsUrl?: string;   // From "discogs" relation
  hasPre2005Release: boolean;
}

// Search MusicBrainz for artist info including official website, Discogs, and release history
async function searchMusicBrainz(query: string): Promise<MusicBrainzResult | null> {
  try {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return null;

    const artist = artists[0];
    if (artist.score < 95) return null;

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

    await delay(1100);

    // Check if artist has pre-2005 releases (for Hoopla/Freegal eligibility)
    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let hasPre2005Release = false;

    if (releasesResponse.ok) {
      const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
      const releaseGroups = releasesData['release-groups'] || [];

      for (const rg of releaseGroups) {
        const firstReleaseDate = rg['first-release-date'];
        if (firstReleaseDate) {
          const year = parseInt(firstReleaseDate.substring(0, 4), 10);
          if (year < 2005) {
            hasPre2005Release = true;
            break;
          }
        }
      }
    }

    return {
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return null;
  }
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

// Scrape release titles from a Faircamp artist page
// Faircamp sites use a consistent static HTML structure: div.release > a (second <a> is the title)
async function getFaircampReleaseTitles(url: string): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 4000);

    if (!response.ok) return [];

    const html = await response.text();
    const root = parse(html);
    const titles: string[] = [];

    // Faircamp uses div.release for each release, with the second <a> containing the title text
    const releases = root.querySelectorAll('.release');
    for (const release of releases) {
      const links = release.querySelectorAll('a');
      // The second <a> in a .release div is the title link (first is the cover image link)
      if (links.length >= 2) {
        const title = links[1].textContent?.trim();
        if (title) titles.push(normalizeForComparison(title));
      }
    }

    if (titles.length > 0) {
      console.log(`[Faircamp] Found ${titles.length} releases at ${url}`);
    }
    return titles;
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error(`[Faircamp] Error fetching releases from ${url}:`, err.message);
    }
    return [];
  }
}

// Jam.coop artist directory cache
let jamcoopDirectoryCache: Map<string, { name: string; url: string }> | null = null;
let jamcoopCacheTime = 0;
const JAMCOOP_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getJamcoopDirectory(): Promise<Map<string, { name: string; url: string }>> {
  const now = Date.now();
  if (jamcoopDirectoryCache && (now - jamcoopCacheTime) < JAMCOOP_CACHE_TTL) {
    return jamcoopDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://jam.coop/artists', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) {
      return jamcoopDirectoryCache || new Map();
    }

    const html = await response.text();
    const root = parse(html);
    const directory = new Map<string, { name: string; url: string }>();

    // Find all artist links - they follow pattern /artists/[slug]
    const artistLinks = root.querySelectorAll('a[href^="/artists/"]');

    for (const link of artistLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/artists') continue;

      // Get artist name from link text (may need to clean up whitespace)
      const name = link.textContent?.trim();
      if (!name) continue;

      const normalizedName = normalizeForComparison(name);
      if (normalizedName && !directory.has(normalizedName)) {
        directory.set(normalizedName, {
          name,
          url: `https://jam.coop${href}`,
        });
      }
    }

    jamcoopDirectoryCache = directory;
    jamcoopCacheTime = now;
    console.log(`[Jam.coop] Cached ${directory.size} artists`);
    return directory;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Jam.coop directory fetch error:', err.message);
    return jamcoopDirectoryCache || new Map();
  }
}

async function searchJamcoop(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const queryNormalized = normalizeForComparison(query);

  try {
    const directory = await getJamcoopDirectory();

    for (const [normalizedName, artist] of directory) {
      // Exact match or close match (query contains name or name contains query)
      if (normalizedName === queryNormalized ||
          normalizedName.includes(queryNormalized) ||
          queryNormalized.includes(normalizedName)) {
        results.set(normalizedName, artist.url);
      }
      if (results.size >= 10) break;
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Jam.coop search error:', err.message);
  }

  return results;
}

async function searchPatreon(query: string): Promise<Map<string, string>> {
  const cacheKey = artistCacheKey('patreon', query);

  const { data } = await cacheGetOrFetch<[string, string][]>(
    cacheKey,
    async () => {
      const results: [string, string][] = [];
      const seen = new Set<string>();

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
              if (!seen.has(normalizedName)) {
                seen.add(normalizedName);
                results.push([normalizedName, url]);
              }
              const urlSlug = url.split('/').pop();
              if (urlSlug) {
                const normalizedSlug = normalizeForComparison(urlSlug);
                if (!seen.has(normalizedSlug)) {
                  seen.add(normalizedSlug);
                  results.push([normalizedSlug, url]);
                }
              }
            }
          }
          if (results.length >= 20) break;
        }
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        if (err.name !== 'AbortError') {
          console.error('Patreon search error:', err.message);
        }
      }

      return results;
    },
    PLATFORM_CACHE_TTL
  );

  return new Map(data);
}

// Search Ampwall with Redis caching to minimize API load
// Cache TTL: 30 minutes (1800 seconds)
const AMPWALL_CACHE_TTL = 30 * 60;

async function searchAmpwall(query: string): Promise<Map<string, string>> {
  const cacheKey = artistCacheKey('ampwall', query);

  const { data, cached } = await cacheGetOrFetch<[string, string][]>(
    cacheKey,
    async () => {
      const results: [string, string][] = [];

      // TODO: Replace this with actual Ampwall API call when available
      // Expected API format TBD - placeholder implementation
      //
      // Example expected implementation:
      // const apiUrl = `https://api.ampwall.com/search?q=${encodeURIComponent(query)}`;
      // const response = await fetchWithTimeout(apiUrl, {
      //   headers: {
      //     'Authorization': `Bearer ${process.env.AMPWALL_API_KEY}`,
      //     'Accept': 'application/json',
      //   },
      // }, 5000);
      //
      // if (response.ok) {
      //   const data = await response.json();
      //   for (const artist of data.artists || []) {
      //     const normalizedName = normalizeForComparison(artist.name);
      //     results.push([normalizedName, artist.url]);
      //   }
      // }

      return results;
    },
    AMPWALL_CACHE_TTL
  );

  if (cached) {
    console.log(`[Ampwall] Cache hit for "${query}"`);
  }

  // Convert array back to Map (Redis doesn't serialize Maps well)
  return new Map(data);
}

async function searchQobuz(query: string): Promise<Map<string, string>> {
  const cacheKey = artistCacheKey('qobuz', query);

  const { data } = await cacheGetOrFetch<[string, string][]>(
    cacheKey,
    async () => {
      const results: [string, string][] = [];

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
        const seen = new Set<string>();

        while ((match = interpreterRegex.exec(html)) !== null && results.length < 10) {
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

            if (!seen.has(normalizedName)) {
              seen.add(normalizedName);
              results.push([normalizedName, `https://www.qobuz.com${path}`]);
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
    },
    PLATFORM_CACHE_TTL
  );

  return new Map(data);
}

function generateResultId(name: string, artist?: string): string {
  const normalized = normalizeForComparison(artist ? `${artist}-${name}` : name);
  return normalized || Math.random().toString(36).substring(2);
}

// Extract the subdomain/identifier from a platform URL for uniqueness checking
function extractPlatformIdentifier(url: string, sourceId: SourceId): string {
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
// Search pipeline helpers
// ---------------------------------------------------------------------------

// Search-only platforms: links that are just search URLs, not real presences
const SEARCH_ONLY_PLATFORMS = new Set(['kofi', 'buymeacoffee']);
function isSearchOnlyLink(p: { sourceId: SourceId; url: string }): boolean {
  if (SEARCH_ONLY_PLATFORMS.has(p.sourceId)) return true;
  if (p.sourceId === 'ampwall' && p.url.includes('explore?searchStyle=search')) return true;
  return false;
}

// Platforms where "no releases" is reliable evidence of a different artist
const RELIABLE_RELEASE_PLATFORMS = new Set(['bandcamp']);

// Curated platforms where presence is strong verification signal
const CURATED_PLATFORMS = new Set(['mirlo', 'faircamp', 'jamcoop']);


// Check if a Qobuz name is a variation of a base name (e.g. "mattyoung1" for "mattyoung")
function isQobuzVariation(qobuzName: string, baseName: string): boolean {
  return qobuzName === baseName ||
    (qobuzName.startsWith(baseName) && /^\d+$/.test(qobuzName.slice(baseName.length)));
}

// Collect all release titles from a result's platforms into a Set
function collectReleaseTitles(result: AggregatedResult): Set<string> {
  const titles = new Set<string>();
  for (const p of result.platforms) {
    if (p.allReleaseTitles) p.allReleaseTitles.forEach(t => titles.add(t));
    if (p.latestRelease?.title) titles.add(normalizeForComparison(p.latestRelease.title));
  }
  return titles;
}

// Extract display name from a Qobuz URL slug
function qobuzDisplayName(url: string, fallback: string): string {
  const match = url.match(/\/interpreter\/([^/]+)\//);
  return match
    ? match[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : fallback;
}

// ---------------------------------------------------------------------------
// Phase 1: Aggregate — merge same-name Bandcamp/Mirlo results
// ---------------------------------------------------------------------------

function aggregateResults(allResults: PlatformResult[], query?: string): AggregatedResult[] {
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

function attachQobuzAndSearchLinks(
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
function createQobuzOnlyResults(
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
// Phase 3: Fetch releases & disambiguate
// ---------------------------------------------------------------------------

async function fetchReleasesForDisambiguation(aggregated: AggregatedResult[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const result of aggregated) {
    if (result.type !== 'artist') continue;

    const bc = result.platforms.find(p => p.sourceId === 'bandcamp');
    if (bc) {
      promises.push(getBandcampLatestRelease(bc.url).then(r => { if (r) bc.latestRelease = r; }));
      promises.push(getBandcampReleaseTitles(bc.url).then(t => { if (t.length > 0) bc.allReleaseTitles = t; }));
    }

    const qz = result.platforms.find(p => p.sourceId === 'qobuz');
    if (qz) {
      promises.push(getQobuzLatestRelease(qz.url).then(r => { if (r) qz.latestRelease = r; }));
      promises.push(getQobuzReleaseTitles(qz.url).then(t => { if (t.length > 0) qz.allReleaseTitles = t; }));
    }
  }

  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
}

// Prefer Bandcamp over Qobuz for the featured release (better payouts + preview)
function preferBandcampFeaturedRelease(aggregated: AggregatedResult[]): void {
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
function removeDeadQobuzLinks(aggregated: AggregatedResult[]): void {
  for (const result of aggregated) {
    result.platforms = result.platforms.filter(p => {
      if (p.sourceId !== 'qobuz') return true;
      const hasReleases = p.latestRelease || (p.allReleaseTitles && p.allReleaseTitles.length > 0);
      if (!hasReleases) console.log(`[Cleanup] Removing dead Qobuz link for "${result.name}": ${p.url}`);
      return hasReleases;
    });
  }
}

// Remove Qobuz from results where releases don't match Bandcamp (different artists)
function crossPlatformReleaseComparison(aggregated: AggregatedResult[]): void {
  for (const result of aggregated) {
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
function deduplicateQobuzUrls(aggregated: AggregatedResult[]): void {
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
      console.log(`[Qobuz Dedup] Removing ${qobuzUrl} from "${matches[i].result.name}" (${matches[i].matchCount} matches) - keeping on "${matches[0].result.name}" (${matches[0].matchCount} matches)`);
      matches[i].result.platforms = matches[i].result.platforms.filter(p => p.url !== qobuzUrl);
    }
  }
}

// Re-create standalone results for Qobuz profiles removed from all results
function createOrphanedQobuzStandalones(
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
function splitSuspiciousPlatforms(aggregated: AggregatedResult[]): AggregatedResult[] {
  const disambiguated: AggregatedResult[] = [];

  for (const result of aggregated) {
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
function mergeByReleaseOverlap(disambiguated: AggregatedResult[]): AggregatedResult[] {
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
// Phase 4: Attach deferred name-only platforms & final filter/sort
// ---------------------------------------------------------------------------

async function attachNameOnlyPlatforms(
  merged: AggregatedResult[],
  nameOnlyMaps: [string, Map<string, string>][],
): Promise<void> {
  // Step 1: Group all name-only platform matches by normalized artist name.
  // This ensures Faircamp + Jamcoop + Bandwagon for the same artist travel together.
  // Also track display names from the original match maps.
  const groupedByName = new Map<string, { sourceId: string; url: string }[]>();
  const displayNames = new Map<string, string>(); // normalizedName -> best display name
  for (const [platformId, matchMap] of nameOnlyMaps) {
    for (const [normalizedName, platformUrl] of matchMap) {
      if (!groupedByName.has(normalizedName)) groupedByName.set(normalizedName, []);
      groupedByName.get(normalizedName)!.push({ sourceId: platformId, url: platformUrl });
      // Try to extract a display name from the URL path
      if (!displayNames.has(normalizedName)) {
        try {
          const urlObj = new URL(platformUrl);
          const slug = urlObj.pathname.split('/').filter(Boolean).pop() || '';
          if (slug) {
            displayNames.set(normalizedName, slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Step 2: For each artist name group, attach or create a new result
  for (const [normalizedName, platforms] of groupedByName) {
    const matching = merged.filter(
      r => r.type === 'artist' && normalizeForComparison(r.name) === normalizedName
    );

    // Filter out platforms already present on any matching result
    const toAttach = platforms.filter(
      p => !matching.some(r => r.platforms.some(rp => rp.sourceId === p.sourceId))
    );
    if (toAttach.length === 0) continue;

    // Unambiguous: only one result with this name
    if (matching.length === 1) {
      for (const p of toAttach) {
        matching[0].platforms.push({ sourceId: p.sourceId as SourceId, url: p.url });
      }
      continue;
    }

    if (matching.length === 0) {
      // No existing results — create a new one with these platforms
      const displayName = displayNames.get(normalizedName) || normalizedName;
      const faircampEntry = toAttach.find(p => p.sourceId === 'faircamp');

      const newResult: AggregatedResult = {
        id: `nameonly-${normalizedName}`,
        name: displayName,
        type: 'artist',
        platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
        matchConfidence: 'unverified',
      };

      // If we have Faircamp, fetch releases to seed the result
      if (faircampEntry) {
        const titles = await getFaircampReleaseTitles(faircampEntry.url);
        if (titles.length > 0) {
          const fcPlatform = newResult.platforms.find(p => p.sourceId === 'faircamp');
          if (fcPlatform) fcPlatform.allReleaseTitles = titles;
          newResult.matchConfidence = 'verified';
        }
      }

      merged.push(newResult);
      console.log(`[Deferred Attach] Created new result for "${displayName}" with ${toAttach.map(p => p.sourceId).join(', ')}`);
      continue;
    }

    // Ambiguous: multiple same-name results exist after disambiguation.
    // Use Faircamp release data to find the right match.
    const faircampPlatform = toAttach.find(p => p.sourceId === 'faircamp');
    let faircampTitles: string[] = [];

    if (faircampPlatform) {
      faircampTitles = await getFaircampReleaseTitles(faircampPlatform.url);
    }

    if (faircampTitles.length > 0) {
      // Compare Faircamp releases against each existing result
      let bestResult: AggregatedResult | null = null;
      let bestOverlap = 0;

      for (const result of matching) {
        const resultTitles = collectReleaseTitles(result);
        if (resultTitles.size === 0) continue;

        const overlap = faircampTitles.filter(t => resultTitles.has(t)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestResult = result;
        }
      }

      if (bestResult && bestOverlap > 0) {
        // Found a match — attach all platforms in this group to that result
        for (const p of toAttach) {
          bestResult.platforms.push({ sourceId: p.sourceId as SourceId, url: p.url });
        }
        // Store Faircamp release titles for future disambiguation
        const fcPlatform = bestResult.platforms.find(p => p.sourceId === 'faircamp');
        if (fcPlatform) fcPlatform.allReleaseTitles = faircampTitles;
        console.log(`[Deferred Attach] Faircamp releases matched "${bestResult.name}" (${bestOverlap} overlapping titles) — attached ${toAttach.map(p => p.sourceId).join(', ')}`);
      } else {
        // No release overlap with any existing result — this is a DIFFERENT artist.
        // Create a new result with all the name-only platforms.
        // Reconstruct a display name from the first matching result (they share the same name)
        const displayName = matching[0].name;
        const newResult: AggregatedResult = {
          id: `nameonly-${normalizedName}-${Date.now()}`,
          name: displayName,
          type: 'artist',
          platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
          matchConfidence: 'verified',
        };
        // Seed Faircamp release titles
        const fcPlatform = newResult.platforms.find(p => p.sourceId === 'faircamp');
        if (fcPlatform) fcPlatform.allReleaseTitles = faircampTitles;

        merged.push(newResult);
        console.log(`[Deferred Attach] No release overlap — created new result for "${displayName}" with ${toAttach.map(p => p.sourceId).join(', ')} (${faircampTitles.length} Faircamp releases)`);
      }
    } else {
      // No Faircamp data available for disambiguation.
      // Create a separate result rather than guessing wrong.
      const displayName = matching[0].name;
      const newResult: AggregatedResult = {
        id: `nameonly-${normalizedName}-${Date.now()}`,
        name: displayName,
        type: 'artist',
        platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
        matchConfidence: 'unverified',
      };
      merged.push(newResult);
      console.log(`[Deferred Attach] Ambiguous "${displayName}" with no Faircamp data — created separate result with ${toAttach.map(p => p.sourceId).join(', ')}`);
    }
  }
}

function filterAndSort(results: AggregatedResult[], query: string): AggregatedResult[] {
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

// ---------------------------------------------------------------------------
// Main search orchestrator
// ---------------------------------------------------------------------------

async function searchAllPlatforms(query: string): Promise<AggregatedResult[]> {
  // Phase 1: Search all platforms in parallel and aggregate Bandcamp/Mirlo results
  const [bandcampResults, bandwagonResults, mirloResults, faircampResults, jamcoopResults, patreonResults, qobuzResults, ampwallResults] = await Promise.allSettled([
    searchBandcamp(query),
    searchBandwagon(query),
    searchMirlo(query),
    searchFaircamp(query),
    searchJamcoop(query),
    searchPatreon(query),
    searchQobuz(query),
    searchAmpwall(query),
  ]);

  const allResults: PlatformResult[] = [];
  if (bandcampResults.status === 'fulfilled') allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  if (mirloResults.status === 'fulfilled') allResults.push(...mirloResults.value.filter(r => r.type === 'artist'));

  const nameOnlyMaps: [string, Map<string, string>][] = [
    ['bandwagon', bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map()],
    ['faircamp', faircampResults.status === 'fulfilled' ? faircampResults.value : new Map()],
    ['jamcoop', jamcoopResults.status === 'fulfilled' ? jamcoopResults.value : new Map()],
    ['patreon', patreonResults.status === 'fulfilled' ? patreonResults.value : new Map()],
  ];
  const qobuzMatches = qobuzResults.status === 'fulfilled' ? qobuzResults.value : new Map<string, string>();
  const ampwallMatches = ampwallResults.status === 'fulfilled' ? ampwallResults.value : new Map<string, string>();

  const aggregated = aggregateResults(allResults, query);

  // Phase 2: Attach Qobuz + search-only links, create Qobuz-only results
  attachQobuzAndSearchLinks(aggregated, qobuzMatches, ampwallMatches);
  createQobuzOnlyResults(aggregated, qobuzMatches);

  // Phase 3: Fetch releases, then disambiguate using release data
  await fetchReleasesForDisambiguation(aggregated);
  preferBandcampFeaturedRelease(aggregated);
  removeDeadQobuzLinks(aggregated);
  crossPlatformReleaseComparison(aggregated);
  deduplicateQobuzUrls(aggregated);
  createOrphanedQobuzStandalones(aggregated, qobuzMatches);
  const disambiguated = splitSuspiciousPlatforms(aggregated);
  const merged = mergeByReleaseOverlap(disambiguated);

  // Phase 4: Attach deferred name-only platforms, filter, and sort
  await attachNameOnlyPlatforms(merged, nameOnlyMaps);
  // Re-merge: new results from Phase 4 may overlap with existing Qobuz standalones
  const finalMerged = mergeByReleaseOverlap(merged);
  return filterAndSort(finalMerged, query);
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
    // Normalize the query to handle accented characters (e.g., "Tanerélle" -> "Tanerelle")
    const normalizedQuery = normalizeSearchQuery(query);

    // Check if there's a claimed artist in the DB matching this query
    const slug = artistSlug(normalizedQuery);
    let claimedResult: AggregatedResult | null = null;
    try {
      const dbArtist = await getArtistBySlug(slug);
      if (dbArtist && dbArtist.matchConfidence === 'claimed') {
        claimedResult = {
          id: `claimed-${slug}`,
          name: dbArtist.name,
          type: 'artist',
          imageUrl: dbArtist.imageUrl,
          platforms: dbArtist.platforms.map(p => ({
            sourceId: p.sourceId as SourceId,
            url: p.url,
            latestRelease: p.latestRelease,
          })),
          matchConfidence: 'claimed',
          claimedSlug: slug,
        };
      }
    } catch (err) {
      console.error('[DB] Claimed artist lookup failed:', err);
    }

    const results = await searchAllPlatforms(normalizedQuery);

    // If we have a claimed artist, put it first and remove any duplicate from live results
    if (claimedResult) {
      const claimedName = normalizeForComparison(claimedResult.name);
      const filtered = results.filter(r => normalizeForComparison(r.name) !== claimedName);
      results.length = 0;
      results.push(claimedResult, ...filtered);
    }

    // Persist artist results to the database (skip claimed results, they're already in DB)
    try {
      await persistSearchResults(results.filter(r => r.matchConfidence !== 'claimed'));
    } catch (err) {
      console.error('[DB] Background persist failed:', err);
    }

    const response: SearchResponse = {
      query, // Return original query for display
      results,
      // Signal client to fetch MusicBrainz data for enrichment (Official Site, Discogs, Hoopla, Freegal)
      hasPendingEnrichment: results.length > 0,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=60, stale-while-revalidate',
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
