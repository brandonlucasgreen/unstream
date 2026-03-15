import { parse } from 'node-html-parser';

interface PlatformUrls {
  bandcamp?: string;
  faircamp?: string;
  mirlo?: string;
  qobuz?: string;
}

interface ReleaseResult {
  releaseName: string;
  releaseDate: string; // ISO format
  releaseUrl: string;
  platform: 'bandcamp' | 'faircamp' | 'mirlo' | 'qobuz';
}

interface CheckReleasesRequest {
  artistName: string;
  platforms: PlatformUrls;
}

interface CheckReleasesResponse {
  artistName: string;
  release: ReleaseResult | null;
  error?: string;
}

// Helper to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 5000): Promise<Response> {
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

// Parse various date formats into ISO string
function parseDateToISO(dateStr: string): string | null {
  // Try ISO format: 2024-12-06
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Try "Month Day, Year" format: December 6, 2024 or Dec 6, 2024
  const monthDayYear = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    const date = new Date(`${month} ${day}, ${year}`);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  // Try "DD MMM YYYY HH:MM:SS GMT" format from Bandcamp JSON-LD
  const bandcampFormat = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+\d{2}:\d{2}:\d{2}/);
  if (bandcampFormat) {
    const [, day, month, year] = bandcampFormat;
    const date = new Date(`${month} ${day}, ${year}`);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  return null;
}

// Check if release is within the last 8 days (slightly lenient for timezone/timing differences)
function isWithinLastWeek(dateStr: string): boolean {
  const releaseDate = new Date(dateStr);
  const now = new Date();
  const daysDiff = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysDiff >= 0 && daysDiff <= 8;
}

// Check Bandcamp for latest release
async function checkBandcamp(artistUrl: string): Promise<ReleaseResult | null> {
  try {
    const baseUrl = artistUrl
      .replace(/\/(music|album|track).*$/, '')
      .replace(/\/$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const root = parse(html);

    // Find the first music grid item (most recent release)
    const musicGridItem = root.querySelector('.music-grid-item');
    if (!musicGridItem) return null;

    const link = musicGridItem.querySelector('a');
    const titleEl = musicGridItem.querySelector('.title');

    if (!link || !titleEl) return null;

    const href = link.getAttribute('href');
    const title = titleEl.textContent?.trim();

    if (!href || !title) return null;

    // Build full URL
    const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();

    // Fetch the album page to get release date
    const albumResponse = await fetchWithTimeout(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!albumResponse.ok) return null;

    const albumHtml = await albumResponse.text();

    // Look for release date in JSON-LD or page content
    const dateMatch = albumHtml.match(/"datePublished":\s*"([^"]+)"/) ||
                      albumHtml.match(/released\s+(\w+\s+\d{1,2},?\s+\d{4})/i);

    if (!dateMatch) return null;

    const releaseDate = parseDateToISO(dateMatch[1]);
    if (!releaseDate) return null;

    return {
      releaseName: title,
      releaseDate,
      releaseUrl: fullUrl,
      platform: 'bandcamp',
    };
  } catch (error) {
    console.error('Bandcamp check error:', error);
    return null;
  }
}

// Check Faircamp via RSS feed
async function checkFaircamp(faircampUrl: string): Promise<ReleaseResult | null> {
  try {
    const baseUrl = faircampUrl.replace(/\/$/, '');
    const rssUrl = `${baseUrl}/feed.rss`;

    const response = await fetchWithTimeout(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) return null;

    const rssText = await response.text();

    // Parse RSS - find first item
    const itemMatch = rssText.match(/<item>[\s\S]*?<\/item>/);
    if (!itemMatch) return null;

    const item = itemMatch[0];

    // Extract title
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/title>/);
    if (!titleMatch) return null;

    // Extract link
    const linkMatch = item.match(/<link>([^<]+)<\/link>/);
    if (!linkMatch) return null;

    // Extract pubDate
    const dateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/);
    if (!dateMatch) return null;

    const pubDate = new Date(dateMatch[1]);
    if (isNaN(pubDate.getTime())) return null;

    const releaseDate = pubDate.toISOString().split('T')[0];

    return {
      releaseName: titleMatch[1].trim(),
      releaseDate,
      releaseUrl: linkMatch[1].trim(),
      platform: 'faircamp',
    };
  } catch (error) {
    console.error('Faircamp check error:', error);
    return null;
  }
}

// Mirlo RSS feed cache
let mirloRssCache: { items: Array<{ title: string; link: string; pubDate: string; artistSlug: string }>; fetchedAt: number } | null = null;
const MIRLO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Check Mirlo via global RSS feed
async function checkMirlo(mirloUrl: string): Promise<ReleaseResult | null> {
  try {
    // Extract artist slug from URL (e.g., "https://mirlo.space/artistname" -> "artistname")
    const slugMatch = mirloUrl.match(/mirlo\.space\/([^/?]+)/);
    if (!slugMatch) return null;
    const artistSlug = slugMatch[1].toLowerCase();

    // Fetch or use cached RSS feed
    const now = Date.now();
    if (!mirloRssCache || (now - mirloRssCache.fetchedAt) > MIRLO_CACHE_TTL) {
      const response = await fetchWithTimeout('https://api.mirlo.space/v1/trackGroups?format=rss', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 10000);

      if (!response.ok) return null;

      const rssText = await response.text();

      // Parse all items from RSS
      const items: typeof mirloRssCache.items = [];
      const itemRegex = /<item>[\s\S]*?<\/item>/g;
      let match;

      while ((match = itemRegex.exec(rssText)) !== null) {
        const item = match[0];

        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/title>/);
        const linkMatch = item.match(/<link>([^<]+)<\/link>/);
        const dateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/);

        if (titleMatch && linkMatch && dateMatch) {
          // Extract artist slug from link (e.g., "https://mirlo.space/artistname/release/..." -> "artistname")
          const itemSlugMatch = linkMatch[1].match(/mirlo\.space\/([^/?]+)/);
          if (itemSlugMatch) {
            const pubDate = new Date(dateMatch[1]);
            if (!isNaN(pubDate.getTime())) {
              items.push({
                title: titleMatch[1].trim(),
                link: linkMatch[1].trim(),
                pubDate: pubDate.toISOString().split('T')[0],
                artistSlug: itemSlugMatch[1].toLowerCase(),
              });
            }
          }
        }
      }

      mirloRssCache = { items, fetchedAt: now };
    }

    // Find releases by this artist
    const artistReleases = mirloRssCache.items.filter(item => item.artistSlug === artistSlug);
    if (artistReleases.length === 0) return null;

    // Return the most recent one
    const latestRelease = artistReleases[0];

    return {
      releaseName: latestRelease.title,
      releaseDate: latestRelease.pubDate,
      releaseUrl: latestRelease.link,
      platform: 'mirlo',
    };
  } catch (error) {
    console.error('Mirlo check error:', error);
    return null;
  }
}

// Check Qobuz via album search
async function checkQobuz(qobuzUrl: string): Promise<ReleaseResult | null> {
  try {
    // Extract artist name from URL (e.g., "/interpreter/artist-name/12345" -> "artist name")
    const slugMatch = qobuzUrl.match(/\/interpreter\/([^/]+)\/\d+/);
    if (!slugMatch) return null;

    const artistSlug = slugMatch[1];
    const artistName = artistSlug.replace(/-/g, ' ');

    // Search for albums by this artist, sorted by release date
    const encodedArtist = encodeURIComponent(artistName);
    const searchUrl = `https://www.qobuz.com/us-en/search/albums/${encodedArtist}?ssf%5Bs%5D=main_catalog_date_desc`;

    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Parse the first album from search results
    // Pattern: <a class="CoverModelOverlay" href="/us-en/album/{slug}/{id}" title="More details on {title} by {artist}."
    const cardPattern = /<a\s+class="CoverModelOverlay"\s+href="(\/us-en\/album\/[^"]+)"\s+title="More details on ([^"]+) by ([^"]+)\."/;
    const match = html.match(cardPattern);

    if (!match) return null;

    const [, albumPath, albumTitle, matchedArtist] = match;

    // Verify artist matches (case-insensitive, partial match allowed)
    const normalizedSearch = artistName.toLowerCase().trim();
    const normalizedMatched = matchedArtist.toLowerCase().trim();
    if (!normalizedMatched.includes(normalizedSearch) && !normalizedSearch.includes(normalizedMatched)) {
      return null;
    }

    // Find release date in the HTML after the album link
    const linkIndex = html.indexOf(albumPath);
    const searchRegion = html.substring(linkIndex, linkIndex + 500);

    // Try various date patterns
    const monthDayYearPattern = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})/i;
    const isoPattern = /(\d{4})-(\d{2})-(\d{2})/;

    let releaseDate: string | null = null;

    const monthMatch = searchRegion.match(monthDayYearPattern);
    if (monthMatch) {
      releaseDate = parseDateToISO(`${monthMatch[1]} ${monthMatch[2]}, ${monthMatch[3]}`);
    }

    if (!releaseDate) {
      const isoMatch = searchRegion.match(isoPattern);
      if (isoMatch) {
        releaseDate = isoMatch[0];
      }
    }

    if (!releaseDate) return null;

    // Decode HTML entities in title
    const decodedTitle = albumTitle
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .trim();

    return {
      releaseName: decodedTitle,
      releaseDate,
      releaseUrl: `https://www.qobuz.com${albumPath}`,
      platform: 'qobuz',
    };
  } catch (error) {
    console.error('Qobuz check error:', error);
    return null;
  }
}

// Main check function - checks all platforms and returns the best result
async function checkAllPlatforms(platforms: PlatformUrls): Promise<ReleaseResult | null> {
  const results: ReleaseResult[] = [];

  // Check all platforms in parallel
  const checks = await Promise.allSettled([
    platforms.bandcamp ? checkBandcamp(platforms.bandcamp) : Promise.resolve(null),
    platforms.faircamp ? checkFaircamp(platforms.faircamp) : Promise.resolve(null),
    platforms.mirlo ? checkMirlo(platforms.mirlo) : Promise.resolve(null),
    platforms.qobuz ? checkQobuz(platforms.qobuz) : Promise.resolve(null),
  ]);

  // Collect successful results that are within the last 7 days
  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value) {
      if (isWithinLastWeek(check.value.releaseDate)) {
        results.push(check.value);
      }
    }
  }

  if (results.length === 0) return null;

  // Priority order: Mirlo > Faircamp > Bandcamp > Qobuz
  const priorityOrder: ReleaseResult['platform'][] = ['mirlo', 'faircamp', 'bandcamp', 'qobuz'];

  // Find the highest priority platform with a release
  for (const platform of priorityOrder) {
    const result = results.find(r => r.platform === platform);
    if (result) return result;
  }

  // Fallback to first result
  return results[0];
}

// Netlify function handler
export async function handler(event: {
  httpMethod?: string;
  body?: string;
  queryStringParameters?: Record<string, string>;
}) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  // Parse request body
  let request: CheckReleasesRequest;
  try {
    request = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // Validate request
  if (!request.artistName || !request.platforms) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'artistName and platforms are required' }),
    };
  }

  // Check if at least one platform URL is provided
  const hasPlatform = request.platforms.bandcamp ||
                      request.platforms.faircamp ||
                      request.platforms.mirlo ||
                      request.platforms.qobuz;

  if (!hasPlatform) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'At least one platform URL is required' }),
    };
  }

  try {
    const release = await checkAllPlatforms(request.platforms);

    const response: CheckReleasesResponse = {
      artistName: request.artistName,
      release,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache', // Don't cache release checks
      },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error('Check releases error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        artistName: request.artistName,
        release: null,
        error: 'Failed to check releases',
      }),
    };
  }
}
