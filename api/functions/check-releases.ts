// Release alerts.
//
// Two paths, and which one runs is the whole point of this file:
//
// 1. **The catalog** (`getReleasesForAlerts`). Preferred. Every release in the window, with
//    every platform it's on and what each costs — built once on the server by the cataloging
//    pipeline rather than re-derived per fan. This is what fixes spec §5 defects 2, 3 and 4:
//    upcoming releases can be alerted on, more than one release per artist survives, and a
//    record on both Bandcamp and Mirlo says so instead of silently picking one.
// 2. **A live scrape**, exactly as before, for an artist the catalog has never seen. Falling
//    back rather than returning nothing matters: coverage is demand-driven, so an artist nobody
//    has saved or searched yet has no catalog, and treating that as "no new releases" would
//    silently switch alerts off for them.
//
// Note what this file does *not* do: it reads the catalog, it never refreshes it. Keeping a
// saved artist's catalog current is the scheduled sweep's job (`recatalog-sweep.ts`). Without
// that, path 1 would read the same catalog forever for anyone nobody searches, which is a
// quieter version of the same bug the fallback above exists to prevent.
//
// The response stays backwards-compatible on purpose. `release` (singular) is still populated
// for the shipped Mac app and browser extension, which decode exactly that field; `releases`
// (plural) is additive and carries what a newer client can use. Both shipped clients decode
// `platform` as a plain string and ignore unknown keys, so neither breaks on the new fields.

import { parse } from 'node-html-parser';
import { isSafePublicHostname, isUrlHostnameAllowed } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import { getReleasesForAlerts, isStoredArtistLink, type AlertRelease } from './db';
import { safeFetch, safeHostname } from './safe-fetch';
import { leadingOfferSummary, orderedSourcePlatforms } from '../shared/release-display';

interface PlatformUrls {
  bandcamp?: string;
  faircamp?: string;
  mirlo?: string;
}

interface ReleaseResult {
  releaseName: string;
  releaseDate: string; // ISO format
  releaseUrl: string;
  /**
   * The platform an alert leads with. Not a closed set any more: with the catalog behind this,
   * a release can lead with any platform in the registry (jam.coop, Discogs, …), and both
   * shipped clients decode this as a plain string.
   */
  platform: string;
}

/** What a catalog-backed alert carries beyond the legacy single-release shape. */
interface CatalogReleaseResult extends ReleaseResult {
  /** Every platform this release is on, artist-paying first. Defect 4: never collapsed to one. */
  platforms: string[];
  /** 'announced' for a release dated in the future — defect 2, which could not fire before. */
  status: string;
  /** "from £3 · ≈£2.55 to artist", or 'Name your price'. Defect 7: a body worth reading. */
  offerSummary: string;
  /** The platform's own page, for a client that would rather link straight to the shop. */
  platformUrl: string;
}

interface CheckReleasesRequest {
  artistName: string;
  platforms: PlatformUrls;
  /** How far back to look. Optional; shipped clients don't send it. */
  sinceDays?: number;
}

interface CheckReleasesResponse {
  artistName: string;
  release: ReleaseResult | null;
  releases?: CatalogReleaseResult[];
  /** Which path answered — so a client (and a human debugging one) can tell. */
  source?: 'catalog' | 'live';
  error?: string;
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

/** Default lookback. Matches the window shipped clients already assume. */
const DEFAULT_WINDOW_DAYS = 31;

/**
 * Ceiling on a caller-supplied window. A year is far more than a client catching up after a
 * long sleep needs, and it stops the parameter being a way to ask for an artist's whole
 * discography through an alerts endpoint.
 */
const MAX_WINDOW_DAYS = 365;

function resolveWindowDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(raw), MAX_WINDOW_DAYS);
}

/**
 * Is this release recent enough to alert on — **or still to come**?
 *
 * The old version of this required `daysDiff >= 0`, which discarded every future-dated release
 * (spec §5 defect 2). A pre-announced record was filtered out for being in the future, and by
 * the time it came out it had usually aged past the window, so it was never alerted on at all.
 * A future date is now the *best* reason to alert, not a disqualification.
 */
function isWithinWindow(dateStr: string, windowDays: number, now: Date = new Date()): boolean {
  const releaseDate = new Date(dateStr);
  if (Number.isNaN(releaseDate.getTime())) return false;
  const daysDiff = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysDiff <= windowDays;
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

    // `href` comes out of fetched HTML, so it is untrusted input. Resolve it against the
    // page we actually landed on — which may be a custom domain after a redirect — and then
    // confine it to that same host.
    //
    // The host check matters because safeFetch only asks "is this target safe to fetch",
    // not "is this target allowlisted or stored for this artist" the way mayFetch does for
    // the entry URL. Without it, any absolute href appearing in fetched markup becomes a
    // URL this endpoint will request, which is a narrower trust boundary than the one
    // established at the entry point and leaves a "fetch an arbitrary third-party URL on
    // our behalf" primitive. Bandcamp's own templates always link same-origin (verified
    // against a live /music page: every grid href is root-relative), so this costs nothing
    // real and still supports the custom-domain redirect this function is built around.
    const landedUrl = response.url || musicUrl;
    let fullUrl: string;
    try {
      fullUrl = new URL(href, landedUrl).toString();
      if (new URL(fullUrl).host !== new URL(landedUrl).host) {
        console.warn(
          `[check-releases] refused cross-host album link: ${safeHostname(fullUrl)} from ${safeHostname(landedUrl)}`
        );
        return null;
      }
    } catch {
      return null;
    }

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
async function checkAllPlatforms(platforms: PlatformUrls, windowDays: number): Promise<ReleaseResult | null> {
  const results: ReleaseResult[] = [];

  // Check all platforms in parallel
  const checks = await Promise.allSettled([
    platforms.bandcamp ? checkBandcamp(platforms.bandcamp) : Promise.resolve(null),
    platforms.faircamp ? checkFaircamp(platforms.faircamp) : Promise.resolve(null),
    platforms.mirlo ? checkMirlo(platforms.mirlo) : Promise.resolve(null),
  ]);

  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value) {
      if (isWithinWindow(check.value.releaseDate, windowDays)) {
        results.push(check.value);
      }
    }
  }

  if (results.length === 0) return null;

  // Priority order: Mirlo > Faircamp > Bandcamp.
  //
  // Still a hardcoded list, and still wrong in the way spec §5 defect 4 describes — a release on
  // both Bandcamp and Mirlo is reported as one platform and the fan never learns about the
  // other. It is left alone deliberately: this path only runs for an artist with no catalog, it
  // has one scraped result per platform and no offer data to rank them by, and the real fix is
  // the catalog path above, which reports every platform. Changing the order here would move
  // the arbitrariness around rather than remove it.
  const priorityOrder = ['mirlo', 'faircamp', 'bandcamp'];

  for (const platform of priorityOrder) {
    const result = results.find(r => r.platform === platform);
    if (result) return result;
  }

  return results[0];
}

// ---------------------------------------------------------------------------
// The catalog path
// ---------------------------------------------------------------------------

/** The Unstream release page an alert should lead to, rather than one platform's shop. */
function releasePageUrl(artistSlug: string, releaseSlug: string): string {
  return `https://unstream.stream/a/${encodeURIComponent(artistSlug)}/${encodeURIComponent(releaseSlug)}`;
}

/**
 * Turn catalogued releases into alert results.
 *
 * Two things here are the product decision, not plumbing:
 *
 * - **`releaseUrl` is the Unstream release page, not the platform's.** That is pillar 3 of the
 *   spec: today an alert hands a fan straight to one shop, which hides the payout comparison at
 *   the exact moment they are deciding where to buy. The platform's own URL is still returned
 *   alongside, as `platformUrl`.
 * - **The leading platform is the artist-paying one**, via `orderedSourcePlatforms` — the same
 *   ordering the release page and the artist page already use, rather than this file's old
 *   hardcoded `mirlo > faircamp > bandcamp`.
 *
 * Releases with no source at all are dropped: an alert a fan cannot act on is noise.
 */
function toCatalogResults(artistSlug: string, releases: AlertRelease[]): CatalogReleaseResult[] {
  const out: CatalogReleaseResult[] = [];

  for (const release of releases) {
    if (!release.releaseDate || release.sources.length === 0) continue;

    const platforms = orderedSourcePlatforms(release.sources);
    const leading = platforms[0];
    const leadingSource = release.sources.find(s => s.platform === leading);

    out.push({
      releaseName: release.title,
      releaseDate: release.releaseDate,
      releaseUrl: releasePageUrl(artistSlug, release.slug),
      platform: leading,
      platforms,
      status: release.status,
      offerSummary: leadingOfferSummary(release.sources),
      platformUrl: leadingSource?.url ?? '',
    });
  }

  return out;
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

  const windowDays = resolveWindowDays(request.sinceDays);

  // The catalog first. Answering from it costs one database read instead of two to four
  // outbound scrapes, and it is the only path that can report an upcoming release, a second
  // release in the same window, or more than one platform.
  //
  // A null here means this artist has never been catalogued — not that they have nothing new —
  // so it falls through to the live scrape rather than reporting a negative we didn't establish.
  try {
    const catalogued = await getReleasesForAlerts(request.artistName, windowDays);
    if (catalogued) {
      const releases = toCatalogResults(catalogued.artistSlug, catalogued.releases);
      const response: CheckReleasesResponse = {
        artistName: request.artistName,
        // Newest first out of the query, so the head is the one a single-release client should
        // show. Still populated for the shipped Mac app and extension, which read only this.
        release: releases[0] ?? null,
        releases,
        source: 'catalog',
      };
      return jsonResponse(200, response, { 'Cache-Control': 'no-cache' });
    }
  } catch (error) {
    // A catalog read failing is not evidence about releases either — fall through and scrape.
    console.error('[check-releases] catalog read failed, falling back to live check:', error);
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
    const release = await checkAllPlatforms(platforms, windowDays);

    const response: CheckReleasesResponse = {
      artistName: request.artistName,
      release,
      // One scraped release at most, so the plural field says the same thing rather than
      // being absent — a client reading `releases` shouldn't have to special-case this path.
      //
      // `offerSummary` is empty and `platforms` has one entry because that is genuinely all a
      // scrape of one platform's latest release establishes. Status is derived rather than
      // assumed 'released': now that a future date is no longer filtered out, a scraped
      // pre-announcement can reach here.
      releases: release
        ? [
            {
              ...release,
              platforms: [release.platform],
              status: release.releaseDate > new Date().toISOString().slice(0, 10) ? 'announced' : 'released',
              offerSummary: '',
              platformUrl: release.releaseUrl,
            },
          ]
        : [],
      source: 'live',
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
