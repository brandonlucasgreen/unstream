import type { IncomingMessage, ServerResponse } from 'http';
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
  | 'hoopla'
  | 'freegal'
  | 'qobuz';

// Social platform types for MusicBrainz enrichment
type SocialPlatform = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'threads' | 'bluesky' | 'twitter';

interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

interface MusicBrainzEnrichmentResponse {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
}

// Parse a URL to determine which social platform it belongs to
function parseSocialUrl(url: string): SocialLink | null {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('instagram.com')) {
    return { platform: 'instagram', url };
  }
  if (urlLower.includes('facebook.com')) {
    return { platform: 'facebook', url };
  }
  if (urlLower.includes('tiktok.com')) {
    return { platform: 'tiktok', url };
  }
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
    return { platform: 'youtube', url };
  }
  if (urlLower.includes('threads.net') || urlLower.includes('threads.com')) {
    return { platform: 'threads', url };
  }
  if (urlLower.includes('bsky.app') || urlLower.includes('bluesky')) {
    return { platform: 'bluesky', url };
  }
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) {
    return { platform: 'twitter', url };
  }

  return null;
}

// Extract Discogs artist ID from URL (e.g., https://www.discogs.com/artist/3840 -> 3840)
function extractDiscogsArtistId(discogsUrl: string): string | null {
  const match = discogsUrl.match(/\/artist\/(\d+)/);
  return match ? match[1] : null;
}

// Fetch social links from Discogs API
async function fetchDiscogsSocialLinks(discogsUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const artistId = extractDiscogsArtistId(discogsUrl);

  if (!artistId) return socialLinks;

  try {
    const response = await globalThis.fetch(`https://api.discogs.com/artists/${artistId}`, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://unstream.stream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('Discogs API failed:', response.status);
      return socialLinks;
    }

    const data = await response.json() as { urls?: string[] };
    const urls = data.urls || [];

    for (const url of urls) {
      const socialLink = parseSocialUrl(url);
      if (socialLink) {
        socialLinks.push(socialLink);
      }
    }
  } catch (error: any) {
    console.error('Discogs fetch error:', error.message);
  }

  return socialLinks;
}

// Fetch social links from an artist's official website
async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const seenPlatforms = new Set<SocialPlatform>();

  try {
    const response = await fetchWithTimeout(officialUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) {
      console.log('Official site fetch failed:', response.status);
      return socialLinks;
    }

    const html = await response.text();

    // Extract all href attributes from the page
    const hrefMatches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of hrefMatches) {
      const url = match[1];
      // Skip relative URLs and non-http URLs
      if (!url.startsWith('http')) continue;

      const socialLink = parseSocialUrl(url);
      // Only add one link per platform (first one wins)
      if (socialLink && !seenPlatforms.has(socialLink.platform)) {
        seenPlatforms.add(socialLink.platform);
        socialLinks.push(socialLink);
      }
    }
  } catch (error: any) {
    console.error('Official site fetch error:', error.message);
  }

  return socialLinks;
}

// Merge social links from multiple sources, deduplicating by platform
function mergeSocialLinks(...linkArrays: SocialLink[][]): SocialLink[] {
  const seenPlatforms = new Set<SocialPlatform>();
  const merged: SocialLink[] = [];

  for (const links of linkArrays) {
    for (const link of links) {
      if (!seenPlatforms.has(link.platform)) {
        seenPlatforms.add(link.platform);
        merged.push(link);
      }
    }
  }

  return merged;
}

interface LatestRelease {
  title: string;
  type: 'album' | 'track';
  url: string;
  imageUrl?: string;
  releaseDate?: string;
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
  }[];
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

    if (!response.ok) {
      console.error('Bandcamp search failed:', response.status);
      return results;
    }

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
    if (error.name === 'AbortError') {
      console.log('Bandcamp search timed out');
    } else {
      console.error('Bandcamp search error:', error.message);
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
        const dateMatch = albumHtml.match(/released\s+(\w+\s+\d+,\s+\d{4})/i) ||
                          albumHtml.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})"/);
        if (dateMatch) {
          releaseDate = dateMatch[1];
        }
      }
    } catch {
      // Ignore errors fetching album page
    }

    return {
      title,
      type,
      url: fullUrl,
      imageUrl: imageUrl || undefined,
      releaseDate,
    };
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Bandcamp latest release fetch error:', error.message);
    }
    return undefined;
  }
}

// Fetch latest release from a Qobuz artist page
// Qobuz is client-side rendered, so we extract album info from URL patterns
// Adding sortBy parameter ensures we get releases sorted by date (most recent first)
async function getQobuzLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
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
    // Extract from the HTML using regex since page is client-rendered
    const albumUrlMatch = html.match(/href="(\/us-en\/album\/([^/]+)\/(\d+))"/);
    if (!albumUrlMatch) return undefined;

    const [, path, albumSlug] = albumUrlMatch;

    // Convert slug to readable title (replace hyphens with spaces, title case)
    const title = albumSlug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    // Build full URL
    const fullUrl = `https://www.qobuz.com${path}`;

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
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Qobuz latest release fetch error:', error.message);
    }
    return undefined;
  }
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

// Search MusicBrainz for major artists and return results with Hoopla if they have pre-2005 releases
async function searchMusicBrainz(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  try {
    // Search for artist - use native fetch without timeout (MusicBrainz needs time for rate limiting)
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return results;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return results;

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) return results;

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await delay(1100);

    // Check if artist has pre-2005 releases
    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!releasesResponse.ok) {
      console.log('MusicBrainz releases search failed:', releasesResponse.status);
      return results;
    }

    const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
    const releaseGroups = releasesData['release-groups'] || [];

    for (const rg of releaseGroups) {
      const firstReleaseDate = rg['first-release-date'];
      if (firstReleaseDate) {
        const year = parseInt(firstReleaseDate.substring(0, 4), 10);
        if (year < 2005) {
          // Found pre-2005 release - add Hoopla and Freegal links
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
  } catch (error: any) {
    console.error('MusicBrainz search error:', error.name, error.message);
  }

  return results;
}

// MusicBrainz enrichment - fetches official URL, Discogs, social links, and pre-2005 release info
async function searchMusicBrainzEnrichment(query: string): Promise<MusicBrainzEnrichmentResponse> {
  const emptyResult: MusicBrainzEnrichmentResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
  };

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
      return emptyResult;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return emptyResult;

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) return emptyResult;

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await delay(1100);

    // Fetch artist details with URL relations
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let officialUrl: string | null = null;
    let discogsUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();

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

      // Extract social links from 'social network' and 'youtube' relation types
      for (const rel of relations) {
        if ((rel.type === 'social network' || rel.type === 'youtube') && rel.url?.resource) {
          const socialLink = parseSocialUrl(rel.url.resource);
          // Only add one link per platform (first one wins)
          if (socialLink && !seenPlatforms.has(socialLink.platform)) {
            seenPlatforms.add(socialLink.platform);
            socialLinks.push(socialLink);
          }
        }
      }
    }

    // Wait again before next request
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

    // Fetch additional social links from Discogs and official site in parallel
    const [discogsSocialLinks, officialSiteSocialLinks] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve([]),
    ]);

    // Merge all social links (MusicBrainz first, then Discogs, then official site)
    const allSocialLinks = mergeSocialLinks(socialLinks, discogsSocialLinks, officialSiteSocialLinks);

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
    };
  } catch (error: any) {
    console.error('MusicBrainz enrichment error:', error.name, error.message);
    return emptyResult;
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
    // Filter to only artist results
    allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  }
  if (mirloResults.status === 'fulfilled') {
    allResults.push(...mirloResults.value.filter(r => r.type === 'artist'));
  }
  if (musicbrainzResults.status === 'fulfilled') {
    allResults.push(...musicbrainzResults.value.filter(r => r.type === 'artist'));
  }

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
        // Buy Me a Coffee (no query search, just link to explore)
        result.platforms.push({
          sourceId: 'buymeacoffee',
          url: 'https://buymeacoffee.com/explore-creators',
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

      // Sort platforms: verified matches first, search-only platforms last
      const searchOnlyPlatforms = new Set(['ampwall', 'kofi', 'buymeacoffee']);
      result.platforms.sort((a, b) => {
        const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
        const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
        if (aIsSearchOnly && !bIsSearchOnly) return 1;
        if (!aIsSearchOnly && bIsSearchOnly) return -1;
        return 0;
      });
    }
  }

  // Fetch latest releases for Bandcamp and Qobuz artist pages in parallel
  const releasePromises: Promise<void>[] = [];
  for (const result of aggregated) {
    if (result.type === 'artist') {
      const bandcampPlatform = result.platforms.find(p => p.sourceId === 'bandcamp');
      if (bandcampPlatform) {
        releasePromises.push(
          getBandcampLatestRelease(bandcampPlatform.url).then(release => {
            if (release) {
              bandcampPlatform.latestRelease = release;
            }
          })
        );
      }

      const qobuzPlatform = result.platforms.find(p => p.sourceId === 'qobuz');
      if (qobuzPlatform) {
        releasePromises.push(
          getQobuzLatestRelease(qobuzPlatform.url).then(release => {
            if (release) {
              qobuzPlatform.latestRelease = release;
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

  // For each result, find the most recent release and only keep platforms with that same release
  for (const result of aggregated) {
    const platformsWithReleases = result.platforms.filter(p => p.latestRelease);
    if (platformsWithReleases.length === 0) continue;

    // Parse dates and find the most recent
    const releasesWithDates = platformsWithReleases.map(p => ({
      platform: p,
      date: parseReleaseDate(p.latestRelease?.releaseDate),
      normalizedTitle: normalizeForComparison(p.latestRelease?.title || ''),
    }));

    // Sort by date descending (most recent first)
    releasesWithDates.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

    // Get the most recent release
    const mostRecent = releasesWithDates[0];
    if (!mostRecent?.normalizedTitle) continue;

    const mostRecentTitle = mostRecent.normalizedTitle;
    const winningRelease = mostRecent.platform.latestRelease!;

    // For platforms that have a different "latest", try to find the winning release on them
    const searchPromises: Promise<void>[] = [];
    for (const platform of result.platforms) {
      if (platform.latestRelease) {
        const normalizedTitle = normalizeForComparison(platform.latestRelease.title);
        if (normalizedTitle !== mostRecentTitle) {
          // This platform has a different release - try to find the winning release
          if (platform.sourceId === 'bandcamp') {
            searchPromises.push(
              searchBandcampForAlbum(platform.url, winningRelease.title).then(albumUrl => {
                if (albumUrl) {
                  platform.latestRelease = {
                    ...winningRelease,
                    url: albumUrl,
                  };
                } else {
                  platform.latestRelease = undefined;
                }
              })
            );
          } else {
            // For other platforms, just clear if no match
            platform.latestRelease = undefined;
          }
        }
      }
    }

    // Wait for album searches
    if (searchPromises.length > 0) {
      await Promise.allSettled(searchPromises);
    }
  }

  return aggregated;
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

// Fetch Bandcamp embed data for an artist, album, or track URL
async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    // Check if the URL is already an album or track page
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    // Fetch the page
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return null;

    const html = await response.text();

    // If we're on an album or track page, extract the ID directly
    if (isAlbumUrl || isTrackUrl) {
      const itemType = isAlbumUrl ? 'album' : 'track';

      // Check if this content is embeddable
      const embeddableMatch = html.match(/"public_embeddable":(true|false)/);
      if (embeddableMatch && embeddableMatch[1] === 'false') {
        console.log('Bandcamp content is not publicly embeddable');
        return null;
      }

      // Try multiple patterns to find the item ID
      // Pattern 1: tralbum_param in data-embed JSON
      const tralbumMatch = html.match(/"tralbum_param":\s*\{\s*"name"\s*:\s*"(album|track)"\s*,\s*"value"\s*:\s*(\d+)\s*\}/);
      // Pattern 2: Direct album= or track= in URL or script
      const directMatch = html.match(new RegExp(`${itemType}=(\\d+)`));
      // Pattern 3: data attribute
      const dataMatch = html.match(new RegExp(`data-${itemType}-id="(\\d+)"`));
      // Pattern 4: JSON property
      const jsonMatch = html.match(new RegExp(`"${itemType}_id"\\s*:\\s*(\\d+)`));
      // Pattern 5: "id" in current object for album/track
      const currentIdMatch = html.match(/"current"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);

      const idMatch = tralbumMatch || directMatch || dataMatch || jsonMatch || currentIdMatch;
      if (!idMatch) return null;

      // Get the ID from the appropriate capture group
      const itemId = tralbumMatch ? tralbumMatch[2] : idMatch[1];

      // Extract title
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

      return {
        embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
        title,
      };
    }

    // Otherwise, it's an artist page - look for album or track links
    const albumMatch = html.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = html.match(/href="(\/track\/[^"]+)"/);

    let itemPath = albumMatch?.[1] || trackMatch?.[1];
    let itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    // If no album/track links found, check if the page itself is a track page
    if (!itemPath) {
      // Check for track ID directly on the page (for single-track artists)
      const trackIdMatch = html.match(/data-item-id="track-(\d+)"/);
      if (trackIdMatch) {
        const trackId = trackIdMatch[1];
        return {
          embedUrl: `https://bandcamp.com/EmbeddedPlayer/track=${trackId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
          title: 'Track',
        };
      }
      return null;
    }

    // Extract base URL for constructing the full item URL
    const baseUrl = url.replace(/\/$/, '').replace(/\/music$/, '');
    const itemUrl = baseUrl + itemPath;

    const itemResponse = await fetchWithTimeout(itemUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!itemResponse.ok) return null;

    const itemHtml = await itemResponse.text();

    // Extract the item ID
    const idMatch = itemHtml.match(new RegExp(`${itemType}=(\\d+)`));
    if (!idMatch) return null;

    const itemId = idMatch[1];

    // Extract title
    const titleMatch = itemHtml.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

    return {
      embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
      title,
    };
  } catch (error: any) {
    console.error('Bandcamp embed error:', error.message);
    return null;
  }
}

// Resolve artist name from Spotify or Apple Music URL
async function resolveStreamingUrl(url: string): Promise<{ artistName: string; source: 'spotify' | 'apple' } | null> {
  try {
    // Handle Spotify URI format (spotify:artist:ID)
    if (url.startsWith('spotify:')) {
      const parts = url.split(':');
      if (parts.length >= 3) {
        // Convert URI to URL format
        url = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      }
    }

    // Check if it's a Spotify URL
    const spotifyMatch = url.match(/open\.spotify\.com\/(artist|album|track)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();

      // For artist pages, og:title is the artist name
      // For albums/tracks, we need to find the artist name differently
      const type = spotifyMatch[1];

      if (type === 'artist') {
        // Artist page: og:title is the artist name
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          return { artistName: titleMatch[1], source: 'spotify' };
        }
      } else {
        // Album/track page: look for artist in various places
        // Try og:description which often has "by Artist Name"
        const descMatch = html.match(/<meta\s+property="og:description"\s+content="[^"]*(?:by|from)\s+([^"·]+)/i) ||
                         html.match(/<meta\s+content="[^"]*(?:by|from)\s+([^"·]+)"\s+property="og:description"/i);
        if (descMatch) {
          return { artistName: descMatch[1].trim(), source: 'spotify' };
        }

        // Try to find artist link in the HTML
        const artistLinkMatch = html.match(/href="\/artist\/[^"]+">([^<]+)<\/a>/);
        if (artistLinkMatch) {
          return { artistName: artistLinkMatch[1].trim(), source: 'spotify' };
        }

        // Fallback: parse title which is often "Song - Artist" or "Album - Artist"
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const parts = titleMatch[1].split(/\s*[-–—]\s*/);
          if (parts.length >= 2) {
            // Usually format is "Track/Album - Artist - Spotify" or similar
            // Take the second part, removing " - Spotify" suffix if present
            let artist = parts[1].replace(/\s*[-–—]\s*Spotify.*$/i, '').trim();
            if (artist && artist.toLowerCase() !== 'spotify') {
              return { artistName: artist, source: 'spotify' };
            }
          }
        }
      }

      return null;
    }

    // Check if it's an Apple Music URL
    const appleMatch = url.match(/music\.apple\.com\/[a-z]{2}\/(artist|album|song)\/([^/]+)\/(\d+)/);
    if (appleMatch) {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();
      const type = appleMatch[1];

      if (type === 'artist') {
        // Artist page: og:title is the artist name
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          // Remove " - Apple Music" or " on Apple Music" suffix if present
          const artistName = titleMatch[1]
            .replace(/\s*[-–—]\s*Apple Music.*$/i, '')
            .replace(/\s+on Apple Music.*$/i, '')
            .trim();
          return { artistName, source: 'apple' };
        }
      } else {
        // Album/song page: title format is usually "Album/Song by Artist" or "Album by Artist on Apple Music"
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          // Extract artist name, handling various formats
          const byMatch = titleMatch[1].match(/^.+?\s+by\s+(.+?)(?:\s+on Apple Music|\s*[-–—]\s*Apple Music)?$/i);
          if (byMatch) {
            return { artistName: byMatch[1].trim(), source: 'apple' };
          }
        }

        // Try twitter:audio:artist_name meta tag
        const artistMeta = html.match(/<meta\s+name="twitter:audio:artist_name"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+name="twitter:audio:artist_name"/i);
        if (artistMeta) {
          return { artistName: artistMeta[1], source: 'apple' };
        }
      }

      return null;
    }

    // Not a recognized URL format
    return null;
  } catch (error: any) {
    console.error('URL resolution error:', error.message);
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) {
    return false;
  }

  if (url.pathname === '/api/search/sources') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const results = await searchAllPlatforms(query);
      sendJson(res, 200, { query, results, hasPendingEnrichment: results.length > 0 });
    } catch (error) {
      console.error('Search error:', error);
      sendJson(res, 500, { error: 'Failed to search', query, results: [] });
    }
    return true;
  }

  if (url.pathname === '/api/search/musicbrainz') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const result = await searchMusicBrainzEnrichment(query);
      sendJson(res, 200, result);
    } catch (error) {
      console.error('MusicBrainz enrichment error:', error);
      sendJson(res, 500, {
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
        socialLinks: [],
      });
    }
    return true;
  }

  if (url.pathname === '/api/embed/bandcamp') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const artistUrl = url.searchParams.get('url');

    if (!artistUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const embedData = await getBandcampEmbed(artistUrl);
      if (embedData) {
        sendJson(res, 200, embedData);
      } else {
        sendJson(res, 404, { error: 'Could not find embeddable content' });
      }
    } catch (error) {
      console.error('Embed error:', error);
      sendJson(res, 500, { error: 'Failed to fetch embed data' });
    }
    return true;
  }

  if (url.pathname === '/api/resolve/url') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const streamingUrl = url.searchParams.get('url');

    if (!streamingUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const result = await resolveStreamingUrl(streamingUrl);
      if (result) {
        sendJson(res, 200, result);
      } else {
        sendJson(res, 404, { error: 'Could not resolve artist from URL' });
      }
    } catch (error) {
      console.error('Resolve error:', error);
      sendJson(res, 500, { error: 'Failed to resolve URL' });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
