import { parse } from 'node-html-parser';
import { isUrlHostnameAllowed } from './middleware.js';
import { bandcampReleaseType } from './release-utils.js';
import { checkRateLimit, getClientIp } from './ratelimit.js';

// Note on releaseType mapping: the API returns 'album' | 'track' from the
// platform parsers, while the DB stores the enum 'album' | 'single' | 'ep' |
// 'compilation'. mapReleaseType() in release-utils.ts handles the mapping
// ('track' → 'single', 'album' → 'album'). This endpoint returns the raw
// platform values; persistence (via db.ts) applies the mapping.

interface PlatformUrls {
  bandcamp?: string;
  faircamp?: string;
  mirlo?: string;
}

interface ReleaseResult {
  releaseName: string;
  releaseDate: string; // ISO format
  releaseUrl: string;
  platform: 'bandcamp' | 'faircamp' | 'mirlo';
  releaseType: 'album' | 'track';
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

// Check if release is within the last 30 days (slightly lenient for timezone/timing differences)
function isWithinLastMonth(dateStr: string): boolean {
  const releaseDate = new Date(dateStr);
  const now = new Date();
  const daysDiff = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysDiff >= 0 && daysDiff <= 31;
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
      releaseType: bandcampReleaseType(fullUrl),
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
      releaseType: 'album',
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
      releaseType: 'album',
    };
  } catch (error) {
    console.error('Mirlo check error:', error);
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
  ]);

  // Collect successful results that are within the last 30 days
  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value) {
      if (isWithinLastMonth(check.value.releaseDate)) {
        results.push(check.value);
      }
    }
  }

  if (results.length === 0) return null;

  // Priority order: Mirlo > Faircamp > Bandcamp
  const priorityOrder: ReleaseResult['platform'][] = ['mirlo', 'faircamp', 'bandcamp'];

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
  headers?: Record<string, string | undefined>;
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

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Rate limit: strict tier (10 req/min, 500/day) — this endpoint fetches
  // external pages, so it's expensive.
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'strict', corsHeaders);
  if (rl.limited) return rl.response;

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
      headers: corsHeaders,
      body: JSON.stringify({ error: 'artistName and platforms are required' }),
    };
  }

  // Check if at least one platform URL is provided
  const hasPlatform = request.platforms.bandcamp ||
                      request.platforms.faircamp ||
                      request.platforms.mirlo;

  if (!hasPlatform) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'At least one platform URL is required' }),
    };
  }

  // SSRF protection: validate every inbound platform URL against the hostname
  // allowlist before any fetch. This endpoint is called by the Mac app and
  // browser extension with no auth — without this check, it would be an open proxy.
  const platformUrls = [
    request.platforms.bandcamp,
    request.platforms.faircamp,
    request.platforms.mirlo,
  ].filter(Boolean) as string[];

  for (const url of platformUrls) {
    if (!isUrlHostnameAllowed(url)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `URL not allowed: ${url}` }),
      };
    }
  }

  try {
    const release = await checkAllPlatforms(request.platforms);

    // Note: this endpoint is read-only. It does NOT persist to the database.
    // All writes to artist_releases + release_links go through persistSearchResults
    // in db.ts, which runs from the authenticated search pipeline.

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
