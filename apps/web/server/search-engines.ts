import type { SocialPlatform, SocialLink, SourceId, LatestRelease, PlatformResult, MusicBrainzEnrichmentResponse } from './shared-types';
import { fetchWithTimeout, parse } from './shared-utils';

// Parse a URL to determine which social platform it belongs to
export function parseSocialUrl(url: string): SocialLink | null {
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

// Extract Discogs artist ID from URL
export function extractDiscogsArtistId(discogsUrl: string): string | null {
  const match = discogsUrl.match(/\/artist\/(\d+)/);
  return match ? match[1] : null;
}

// Fetch social links from Discogs API
export async function fetchDiscogsSocialLinks(discogsUrl: string): Promise<SocialLink[]> {
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
export async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<SocialLink[]> {
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

    const hrefMatches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of hrefMatches) {
      const url = match[1];
      if (!url.startsWith('http')) continue;

      const socialLink = parseSocialUrl(url);
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

// Merge social links from multiple sources
export function mergeSocialLinks(...linkArrays: SocialLink[][]): SocialLink[] {
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

// Helper to delay execution
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to normalize strings
export function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Helper to generate result ID
export function generateResultId(name: string, artist?: string): string {
  const normalized = normalizeForComparison(artist ? `${artist}-${name}` : name);
  return normalized || Math.random().toString(36).substring(2);
}

// Helper to score text matches
export function textMatchScore(name: string, query: string): number {
  const normName = normalizeForComparison(name);
  const normQuery = normalizeForComparison(query);
  if (normName === normQuery) return 3;
  if (normName.startsWith(normQuery)) return 2;
  if (normName.includes(normQuery)) return 1;
  return 0;
}

// Parse various date formats
export function parseReleaseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  const monthDayYear = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    const monthIndex = new Date(`${month} 1, 2000`).getMonth();
    if (!isNaN(monthIndex)) {
      return new Date(parseInt(year), monthIndex, parseInt(day));
    }
  }

  const slashDate = dateStr.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (slashDate) {
    const [, first, second, year] = slashDate;
    return new Date(parseInt(year), parseInt(first) - 1, parseInt(second));
  }

  return undefined;
}

// Search Bandcamp by scraping search results
export async function searchBandcamp(query: string): Promise<PlatformResult[]> {
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
      const resultType = item.querySelector('.searchresult .result-info .itemtype')?.textContent?.trim().toLowerCase();
      const heading = item.querySelector('.searchresult .result-info .heading a');
      const name = heading?.textContent?.trim();
      const url = heading?.getAttribute('href')?.split('?')[0];

      const subhead = item.querySelector('.searchresult .result-info .subhead')?.textContent?.trim();
      let artist: string | undefined;
      if (subhead && subhead.startsWith('by ')) {
        artist = subhead.substring(3).trim();
      }

      const img = item.querySelector('.searchresult .art img');
      const imageUrl = img?.getAttribute('src');

      if (name && url) {
        let type: 'artist' | 'album' | 'track' = 'artist';
        if (resultType === 'album') type = 'album';
        else if (resultType === 'track') type = 'track';

        results.push({
          sourceId: 'bandcamp' as SourceId,
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

// Search Bandcamp for a specific album title
export async function searchBandcampForAlbum(artistUrl: string, albumTitle: string): Promise<string | undefined> {
  try {
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

    const musicGridItems = root.querySelectorAll('.music-grid-item');
    for (const item of musicGridItems) {
      const titleEl = item.querySelector('.title');
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      const normalizedTitle = normalizeForComparison(title);
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

// Fetch latest release from a Bandcamp artist page
export async function getBandcampLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
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

    const type: 'album' | 'track' = href.includes('/track/') ? 'track' : 'album';
    const fullUrl = href.startsWith('http') ? href : new URL(href, artistUrl).toString();

    let releaseDate: string | undefined;
    try {
      const albumResponse = await fetchWithTimeout(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 3000);

      if (albumResponse.ok) {
        const albumHtml = await albumResponse.text();
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
export async function getQobuzLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
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

    const albumUrlMatch = html.match(/href="(\/us-en\/album\/([^/]+)\/(\d+))"/);
    if (!albumUrlMatch) return undefined;

    const [, path, albumSlug] = albumUrlMatch;

    const title = albumSlug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const fullUrl = `https://www.qobuz.com${path}`;

    let releaseDate: string | undefined;
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
      imageUrl: undefined,
      releaseDate,
    };
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Qobuz latest release fetch error:', error.message);
    }
    return undefined;
  }
}

// Search Bandwagon for artists
export async function searchBandwagon(query: string): Promise<Map<string, string>> {
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
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Bandwagon search error:', error.message);
    }
  }

  return results;
}

// Search MusicBrainz for major artists
export async function searchMusicBrainz(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  try {
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
    if (artist.score < 95) return results;

    await delay(1100);

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
          console.log('Adding Hoopla and Freegal for:', artist.name);
          const hooplaSearchUrl = `https://www.hoopladigital.com/search?q=${encodeURIComponent(artist.name)}&type=music`;
          results.push({
            sourceId: 'hoopla' as SourceId,
            name: artist.name,
            type: 'artist' as const,
            url: hooplaSearchUrl,
          });
          const freegalArtistId = Buffer.from(artist.name).toString('base64');
          results.push({
            sourceId: 'freegal' as SourceId,
            name: artist.name,
            type: 'artist' as const,
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

// MusicBrainz enrichment
export async function searchMusicBrainzEnrichment(query: string): Promise<MusicBrainzEnrichmentResponse> {
  const emptyResult: MusicBrainzEnrichmentResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
  };

  try {
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
    if (artist.score < 95) return emptyResult;

    await delay(1100);

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

      for (const rel of relations) {
        if (rel.type === 'official homepage' && rel.url?.resource) {
          officialUrl = rel.url.resource;
          break;
        }
      }

      for (const rel of relations) {
        if (rel.type === 'discogs' && rel.url?.resource) {
          discogsUrl = rel.url.resource;
          break;
        }
      }

      for (const rel of relations) {
        if ((rel.type === 'social network' || rel.type === 'youtube') && rel.url?.resource) {
          const socialLink = parseSocialUrl(rel.url.resource);
          if (socialLink && !seenPlatforms.has(socialLink.platform)) {
            seenPlatforms.add(socialLink.platform);
            socialLinks.push(socialLink);
          }
        }
      }
    }

    await delay(1100);

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

    const [discogsSocialLinks, officialSiteSocialLinks] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve([]),
    ]);

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

// Search Mirlo by checking if artist page exists
export async function searchMirlo(query: string): Promise<PlatformResult[]> {
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
          sourceId: 'mirlo' as SourceId,
          name: ogTitleMatch[1],
          type: 'artist' as const,
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

// Search Faircamp webring directory
export async function searchFaircamp(query: string): Promise<Map<string, string>> {
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
  } catch (error: any) {
    console.error('Faircamp search error:', error.message);
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

// Search Patreon API
export async function searchPatreon(query: string): Promise<Map<string, string>> {
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
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Patreon search error:', error.message);
    }
  }

  return results;
}

// Search Qobuz
export async function searchQobuz(query: string): Promise<Map<string, string>> {
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

    const interpreterRegex = /href="(\/us-en\/interpreter\/([^/]+)\/(\d+))"/g;
    let match;
    const queryNormalized = normalizeForComparison(query);

    while ((match = interpreterRegex.exec(html)) !== null && results.size < 10) {
      const [, path, slug] = match;
      const slugNormalized = slug.replace(/-/g, '');

      if (slugNormalized === queryNormalized ||
          slugNormalized.includes(queryNormalized) ||
          queryNormalized.includes(slugNormalized)) {
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

// Search Beatport
export async function searchBeatport(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return results;

    const html = await response.text();
    const scriptEl = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!scriptEl) return results;

    const jsonStr = scriptEl[1];
    let json: any;
    try {
      json = JSON.parse(jsonStr);
    } catch {
      return results;
    }

    const queries = json?.props?.pageProps?.dehydratedState?.queries;
    let artists: { artist_id: number; artist_name: string }[] | undefined;
    for (const q of queries || []) {
      const data = q?.state?.data?.artists?.data;
      if (Array.isArray(data)) {
        artists = data;
        break;
      }
    }
    if (!artists) return results;

    const queryNormalized = normalizeForComparison(query);

    for (const artist of artists.slice(0, 10)) {
      const { artist_name, artist_id } = artist;
      if (!artist_name || !artist_id) continue;

      const normalizedName = normalizeForComparison(artist_name);

      const isMatch = normalizedName === queryNormalized ||
        queryNormalized.startsWith(normalizedName) ||
        (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

      if (isMatch && !results.has(normalizedName)) {
        const slug = artist_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        results.set(normalizedName, `https://www.beatport.com/artist/${slug}/${artist_id}`);
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Beatport search error:', error.message);
    }
  }

  return results;
}

// Search EVEN via Algolia API
export async function searchEven(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  const algoliaAppId = process.env.ALGOLIA_APP_ID || 'S64VD9CU46';
  const algoliaApiKey = process.env.ALGOLIA_API_KEY;
  if (!algoliaApiKey) {
    console.warn('[EVEN] Missing ALGOLIA_API_KEY env var, skipping Even search');
    return results;
  }

  try {
    const response = await fetchWithTimeout(`https://${algoliaAppId}-dsn.algolia.net/1/indexes/Artist/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': algoliaAppId,
        'X-Algolia-API-Key': algoliaApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage: 10 }),
    }, 5000);

    if (!response.ok) return results;

    const json = await response.json();
    const queryNormalized = normalizeForComparison(query);

    for (const hit of (json as { hits?: { name?: string; slug?: string; username?: string }[] }).hits || []) {
      const name = hit.name;
      const slug = hit.slug || hit.username;
      if (!name || !slug) continue;

      const normalizedName = normalizeForComparison(name);

      const isMatch = normalizedName === queryNormalized ||
        queryNormalized.startsWith(normalizedName) ||
        (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

      if (isMatch && !results.has(normalizedName)) {
        results.set(normalizedName, `https://even.biz/artists/${slug}`);
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('EVEN search error:', error.message);
    }
  }

  return results;
}

