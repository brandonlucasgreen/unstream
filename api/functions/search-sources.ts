import { parse } from 'node-html-parser';
import { cacheGetOrFetch, artistCacheKey } from './cache';
import { persistSearchResults, getArtistBySlug, artistSlug, getMergeOverrides } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import {
  type SourceId,
  type LatestRelease,
  type PlatformResult,
  type AggregatedResult,
  type SearchResponse,
  normalizeSearchQuery,
  normalizeForComparison,
  namesMatch,
  CURATED_PLATFORMS,
  collectReleaseTitles,
  aggregateResults,
  attachQobuzAndSearchLinks,
  createQobuzOnlyResults,
  preferBandcampFeaturedRelease,
  removeDeadQobuzLinks,
  crossPlatformReleaseComparison,
  deduplicateQobuzUrls,
  createOrphanedQobuzStandalones,
  splitSuspiciousPlatforms,
  mergeByReleaseOverlap,
  filterAndSort,
  applyMergeOverrides,
  displayNameFromSlug,
} from './search-utils';

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
        title: displayNameFromSlug(album.slug),
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
        title: displayNameFromSlug(album.slug),
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
            const artistName = displayNameFromSlug(slug, query);
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
            displayNames.set(normalizedName, displayNameFromSlug(slug));
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
      // No existing results — only create a new result if we have at least one curated platform.
      // Patreon returns fuzzy search results that often don't match by name, so Patreon alone
      // should never create a new result.
      const hasCuratedPlatform = toAttach.some(p => CURATED_PLATFORMS.has(p.sourceId));
      if (!hasCuratedPlatform) {
        console.log(`[Deferred Attach] Skipping "${normalizedName}" — no curated platform, no existing result`);
        continue;
      }

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
      // Only create a separate result if we have curated platforms — otherwise skip.
      const hasCuratedPlatform = toAttach.some(p => CURATED_PLATFORMS.has(p.sourceId));
      if (hasCuratedPlatform) {
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
      } else {
        console.log(`[Deferred Attach] Skipping ambiguous "${normalizedName}" — no Faircamp data, no curated platform`);
      }
    }
  }
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

  // Fetch overrides early so we can reserve their URLs and names during Phase 2
  const overrides = await getMergeOverrides();
  const reservedOverrideUrls = new Set(
    overrides.flatMap(o => o.platform_urls.map(u => u.replace(/\/+$/, '').toLowerCase()))
  );
  const reservedOverrideNames = new Set(
    overrides.map(o => normalizeForComparison(o.group_name))
  );

  // Phase 2: Attach Qobuz + search-only links, create Qobuz-only results
  attachQobuzAndSearchLinks(aggregated, qobuzMatches, ampwallMatches, reservedOverrideUrls, reservedOverrideNames);
  createQobuzOnlyResults(aggregated, qobuzMatches);

  // Phase 2.5: Apply manual merge overrides before release-based disambiguation
  if (overrides.length > 0) {
    applyMergeOverrides(aggregated, overrides);
  }

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

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'strict', corsHeaders);
  if (rl.limited) return rl.response;

  const query = event.queryStringParameters?.query;

  if (!query) {
    return {
      statusCode: 400,
      headers: corsHeaders,
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
