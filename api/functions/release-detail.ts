// API endpoint: GET /api/release/{artist}/{release}
//
// One release's buying guide as JSON — the twin of the HTML page `api/edge/release-page.ts`
// serves at /a/{artist}/{release}. It exists so the Mac app and the browser extension can
// render the payout comparison natively instead of doing what they do today, which is
// `NSWorkspace.shared.open(url)` / `chrome.tabs.create` and handing the whole point of the
// product to a browser tab.
//
// **Not a second renderer of that URL.** The UNS-100 bifurcation rule is about one URL with two
// renderers; this is a different URL returning data, and the HTML page remains the only thing
// that renders /a/{artist}/{release}. What the two must share is the *answer*: both run the same
// query (`getReleaseDetail`) and apply the same payout rules, so a native client can never
// describe a release differently from the web page a fan would see for it.
//
// **`payoutPercent` is computed here, per source, on purpose.** Payout figures are duplicated by
// hand across eight files in this repo, and that drift is what let the Discord bot quote an
// unsourced '86-95%' for Jam.coop to users for months (fixed in PR #389). A client that reads
// the number off the response cannot drift. It also can't miss the Bandcamp Friday override
// below, which no client currently knows exists.

import { getReleaseDetail, type ReleaseDetailSource } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { Sentry } from '../lib/sentry';
import { PLATFORMS } from '../shared/platform-registry';
import { isBandcampFriday } from '../shared/bandcamp-friday';
import { AVAILABILITY_ORDER, payoutRank } from '../shared/release-display';

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  // The wildcard is deliberate, not an oversight — the same reason check-releases.ts carries
  // one: the Mac app and the browser extension both call this endpoint, and neither sends an
  // Origin that the shared buildCorsHeaders() allowlist (unstream.stream) would accept. The
  // body is the same public data the release page already serves to anyone.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Both slug generators — `artistSlug()` and `releaseSlug()` in release-utils.ts — emit only
 * lowercase alphanumerics and hyphens, so anything else cannot be a slug we ever minted.
 * Refusing those before touching the database means a scan of junk paths costs nothing.
 *
 * Checked against production: all 842 `releases.slug` values match, and the only one of 3,416
 * `artists.slug` values that doesn't is a single empty string — which no URL can address anyway
 * (`/api/release//x` doesn't match the route, and the empty-param check above catches it).
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

function json(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return { statusCode, headers: { ...CORS_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

/**
 * The two slugs, from the request path.
 *
 * **`rawUrl`, not `event.path`.** Behind a `status = 200` rewrite `event.path` can be the rewrite
 * *target* (`/.netlify/functions/release-detail`), which carries no routing information at all.
 * Netlify always sets `rawUrl` to the full original request URL, so that is the source of truth —
 * the same arrangement feed-releases.ts uses, for the same reason.
 *
 * This originally read the slugs from `queryStringParameters`, on the assumption that Netlify
 * substitutes `from` placeholders into a rewrite destination's query string. It does not: on
 * deploy preview 393 the rewrite matched and this function ran with an empty
 * `queryStringParameters`, so every request 400'd. The query-string branch is kept only as a
 * fallback for direct invocation — `/.netlify/functions/release-detail?artist=…&release=…` is a
 * real, working way to call this, and the tests drive it that way too.
 */
export function parseSlugs(event: {
  path?: string;
  rawUrl?: string;
  queryStringParameters?: Record<string, string> | null;
}): { artist: string; release: string } | null {
  const path = (() => {
    if (event.rawUrl) {
      try {
        return new URL(event.rawUrl).pathname;
      } catch {
        // fall through to `path`
      }
    }
    return event.path || '';
  })();

  const match = path.replace(/\/$/, '').match(/^\/api\/release\/([^/]+)\/([^/]+)$/);
  if (match) {
    try {
      return { artist: decodeURIComponent(match[1]), release: decodeURIComponent(match[2]) };
    } catch {
      // A malformed percent-escape can't be a slug we minted; fall through and let the caller 404.
      return null;
    }
  }

  const artist = event.queryStringParameters?.artist;
  const release = event.queryStringParameters?.release;
  return artist && release ? { artist, release } : null;
}

/** One source's offers, ordered the way the release page orders them: what you can buy first,
 *  cheapest first within that, and anything you can't buy at the bottom. */
function sortedOffers(source: ReleaseDetailSource) {
  return [...source.offers].sort((a, b) => {
    const availability = (AVAILABILITY_ORDER[a.availability] ?? 2) - (AVAILABILITY_ORDER[b.availability] ?? 2);
    if (availability !== 0) return availability;
    return (a.price ?? Infinity) - (b.price ?? Infinity);
  });
}

export async function handler(event: {
  httpMethod?: string;
  path?: string;
  rawUrl?: string;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string | undefined>;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  // 'lenient' because a client fetches this when a person taps a release, and a household
  // behind one IP browsing a few records is normal traffic rather than abuse.
  const rl = await checkRateLimit(getClientIp(event.headers || {}), 'lenient', CORS_HEADERS);
  // `response` is optional on the result type, so it gets a 429 of its own rather than a cast:
  // returning `undefined` here would serve a rate-limited request as an empty 200.
  if (rl.limited) return rl.response ?? json(429, { error: 'Rate limit exceeded' });

  const slugs = parseSlugs(event);
  if (!slugs) {
    return json(400, { error: 'artist and release are required' });
  }
  const { artist, release } = slugs;

  if (!SLUG_PATTERN.test(artist) || !SLUG_PATTERN.test(release)) {
    return json(404, { error: 'Release not found' });
  }

  try {
    const { detail, failed } = await getReleaseDetail(artist, release);

    // The lookup itself broke. A 503 with no caching, never a 404 — a Supabase outage rendered
    // as "this release doesn't exist" would be a convincing lie, and one the CDN would then
    // hold for five minutes. Never cache uncertainty.
    if (failed) {
      Sentry.captureMessage('[release-detail] release lookup failed', {
        level: 'error',
        tags: { artist, release },
        extra: { context: 'release-detail.lookupFailed' },
      });
      return json(503, { error: 'Release lookup temporarily unavailable' }, { 'Cache-Control': 'no-store' });
    }

    // Genuinely absent: an unknown artist, a stale link from an old alert, or a release the
    // artist has since hidden. Deliberately one 404 for all of them — `is_hidden` exists to
    // make a suppressed release indistinguishable from one that was never catalogued.
    if (!detail) {
      return json(404, { error: 'Release not found' });
    }

    const bandcampFriday = isBandcampFriday();

    // Artist-paying first, the same ordering the release page and the feeds use. Without it a
    // secondhand Discogs listing could lead over a direct purchase from the artist, which would
    // be off-mission even though both facts are true.
    const sources = [...detail.release.sources]
      .sort((a, b) => payoutRank(b.platform) - payoutRank(a.platform))
      .map(source => {
        const info = PLATFORMS[source.platform];
        const isBCFriday = source.platform === 'bandcamp' && bandcampFriday;
        // On a Bandcamp Friday Bandcamp waives its revenue share, so the registry's usual range
        // is simply wrong for the next 24 hours. The release page already overrides it; a client
        // rendering the same guide from this response has to get the same number.
        return {
          platform: source.platform,
          name: info?.name ?? source.platform,
          url: source.url,
          payoutPercent: isBCFriday ? '~97%' : (info?.payoutPercent ?? null),
          bandcampFriday: isBCFriday,
          detailCheckedAt: source.detailCheckedAt,
          offers: sortedOffers(source),
        };
      });

    // The oldest price across every source is the honest freshness claim: saying "checked today"
    // because *one* source was re-read would overstate the rest. ISO rather than the page's
    // "3 days ago" — a native client formats dates in the user's own locale.
    const pricesCheckedAt = sources
      .flatMap(s => s.offers.map(o => o.capturedAt))
      .filter(Boolean)
      .sort()[0] ?? null;

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 's-maxage=300, stale-while-revalidate=86400',
        'Cache-Tag': `release-detail-${artist}-${release}`,
      },
      body: JSON.stringify({
        artist: detail.artist,
        release: {
          slug: detail.release.slug,
          title: detail.release.title,
          releaseType: detail.release.releaseType,
          releaseDate: detail.release.releaseDate,
          datePrecision: detail.release.datePrecision,
          status: detail.release.status,
          artworkUrl: detail.release.artworkUrl,
          pricesCheckedAt,
          sources,
        },
        // The page URL, so a native client can offer "open the full guide" without rebuilding
        // the URL shape — and so the two surfaces stay tied together if it ever changes.
        pageUrl: `https://unstream.stream/a/${encodeURIComponent(artist)}/${encodeURIComponent(release)}`,
        bandcampFriday,
      }),
    };
  } catch (error) {
    console.error('[release-detail] Error:', error);
    return json(500, { error: 'Internal server error' });
  }
}
