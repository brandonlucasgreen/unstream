import { parse } from 'node-html-parser';
import { isSafePublicHostname, isUrlHostnameAllowed } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isStoredArtistLink } from './db';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Bandcamp Pro artists point custom domains at their store, so a single request can
// legitimately redirect off *.bandcamp.com. Follow a few hops, validating each one.
const MAX_REDIRECTS = 5;

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

/**
 * Fetch with a timeout, validating **every** hop against `isSafePublicHostname`.
 *
 * Node's fetch follows redirects transparently, which means a check on the URL we were
 * given says nothing about the URL we actually retrieve. That matters here for two
 * reasons: this endpoint fetches caller-supplied URLs, and it then follows a link found
 * *inside* the page it fetched. Redirects are resolved manually so each destination is
 * re-validated before another request goes out.
 *
 * Returns null when a target is refused or the redirect chain is too long — callers treat
 * that the same as an unreachable platform.
 */
async function safeFetch(url: string, timeoutMs: number = 5000): Promise<Response | null> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafePublicHostname(current)) {
      // Hostname only — the full URL is caller-supplied and shouldn't land in logs.
      console.warn(`[check-releases] refused unsafe fetch target: ${safeHostname(current)}`);
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response; // 3xx without a target — nothing to follow
    current = new URL(location, current).toString();
  }

  console.warn(`[check-releases] too many redirects from ${safeHostname(url)}`);
  return null;
}

function safeHostname(urlString: string): string {
  try {
    return new URL(urlString).hostname;
  } catch {
    return '<unparseable>';
  }
}

/**
 * May we fetch this URL on an anonymous caller's behalf?
 *
 * Allowlisted hosts pass outright. Anything else must already be stored as a link for
 * this artist — which is how self-hosted Faircamp (arbitrary domains like
 * music.someartist.com) and Bandcamp custom domains stay reachable without turning the
 * endpoint into an open fetch proxy.
 */
async function mayFetch(url: string, artistName: string): Promise<boolean> {
  if (!isSafePublicHostname(url)) return false;
  if (isUrlHostnameAllowed(url)) return true;
  return isStoredArtistLink(url, artistName);
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

    const response = await safeFetch(musicUrl);
    if (!response || !response.ok) return null;

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

    // Build full URL. `href` comes out of fetched HTML, so it is untrusted input — it is
    // resolved against the page we actually landed on (which may be a custom domain after
    // a redirect) and then re-validated by safeFetch before the second request.
    const fullUrl = href.startsWith('http') ? href : new URL(href, response.url || baseUrl).toString();

    // Fetch the album page to get release date
    const albumResponse = await safeFetch(fullUrl);
    if (!albumResponse || !albumResponse.ok) return null;

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

    const response = await safeFetch(rssUrl);
    if (!response || !response.ok) return null;

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
      // Hardcoded endpoint, so there's no caller-supplied URL to validate here — it still
      // goes through safeFetch to keep one fetch path in this file.
      const response = await safeFetch('https://api.mirlo.space/v1/trackGroups?format=rss', 10000);
      if (!response || !response.ok) return null;

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

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  // The wildcard is deliberate, not an oversight: the Mac app and the browser extension
  // both call this endpoint, and neither sends an Origin that the shared
  // buildCorsHeaders() allowlist (unstream.stream) would accept.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PLATFORM_KEYS = ['bandcamp', 'faircamp', 'mirlo'] as const;

function jsonResponse(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return { statusCode, headers: { ...CORS_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

// Netlify function handler
export async function handler(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  queryStringParameters?: Record<string, string>;
}) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
  }

  // 'lenient' (120/min, 5000/day) rather than 'strict' (10/min): the Mac app and the
  // extension both loop once per saved artist with no delay and swallow errors, so a
  // strict tier would silently stop release alerts for every artist past the tenth.
  // A batch request shape is the real fix; until shipped clients support one, the limit
  // has to fit the caller it already has.
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'lenient', CORS_HEADERS);
  if (rl.limited) return rl.response;

  // Parse request body
  let request: CheckReleasesRequest;
  try {
    request = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // Validate request
  if (!request.artistName || typeof request.artistName !== 'string' || !request.platforms) {
    return jsonResponse(400, { error: 'artistName and platforms are required' });
  }

  const requested = PLATFORM_KEYS.filter(
    p => typeof request.platforms[p] === 'string' && (request.platforms[p] as string).length > 0
  );

  if (requested.length === 0) {
    return jsonResponse(400, { error: 'At least one platform URL is required' });
  }

  // Only fetch URLs we're willing to request on an anonymous caller's behalf.
  const platforms: PlatformUrls = {};
  const refused: string[] = [];
  await Promise.all(
    requested.map(async p => {
      const url = request.platforms[p] as string;
      if (await mayFetch(url, request.artistName)) platforms[p] = url;
      else refused.push(`${p}:${safeHostname(url)}`);
    })
  );

  if (refused.length > 0) {
    console.warn(`[check-releases] refused unverified URL(s): ${refused.join(', ')}`);
  }

  // Refusing to look is not the same as looking and finding nothing — say so rather than
  // returning an empty result that reads as "this artist has no new release".
  if (Object.keys(platforms).length === 0) {
    return jsonResponse(400, {
      artistName: request.artistName,
      release: null,
      error: 'No platform URL could be verified for this artist',
    });
  }

  try {
    const release = await checkAllPlatforms(platforms);

    const response: CheckReleasesResponse = {
      artistName: request.artistName,
      release,
    };

    // Don't cache release checks
    return jsonResponse(200, response, { 'Cache-Control': 'no-cache' });
  } catch (error) {
    console.error('Check releases error:', error);
    return jsonResponse(500, {
      artistName: request.artistName,
      release: null,
      error: 'Failed to check releases',
    });
  }
}
