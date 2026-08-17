// API endpoint: /api/me/recent-releases
//
// GET — shortlists of upcoming and recent releases by the signed-in fan's saved artists, for the
// "Upcoming Releases" and "Recent Releases" sections of /dashboard.
//
// Follows the same conventions as the other me-* endpoints (bearer auth against the anon client,
// hand-rolled permissive CORS) and is in api/tsconfig.json's typecheck include — keep it there.

import { getFeedReleasesForUser, type FeedReleaseRow } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/**
 * How many rows each dashboard section shows. A shortlist, not a list: these sit beside Saved
 * Artists and exist to say "here is what's new", so they have to stay glanceable. Six fills three
 * rows of the two-column grid.
 *
 * Applied to each list separately rather than to the pair, because a shared budget reintroduces
 * the bug this split fixed in miniature: a fan with six albums already announced would lose sight
 * of everything that actually came out.
 */
export const RECENT_RELEASE_LIMIT = 6;

/** One response shape for every path, so callers (and tests) don't have to narrow a union. */
interface JsonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function toShortlistRow(row: FeedReleaseRow) {
  return {
    artistName: row.artistName,
    artistSlug: row.artistSlug,
    title: row.title,
    releaseSlug: row.releaseSlug,
    releaseDate: row.releaseDate,
    datePrecision: row.datePrecision,
    artworkUrl: row.artworkUrl,
    // Kept per-source rather than flattened into one price, so the client can order platforms
    // artist-paying-first with the shared `release-display` helpers — the same figures the
    // release page and the feeds use, rather than a ninth copy of the payout maths.
    sources: row.sources.map(s => ({ platform: s.platform, offers: s.offers })),
  };
}

/**
 * Split the fan's window into what hasn't come out yet and what just did, each capped.
 *
 * `getFeedReleasesForUser` returns both in one ascending list — the right shape for a calendar or
 * a reader, where the next thing belongs at the top. On the dashboard they answer two different
 * questions, and mixing them meant an announced-but-unreleased album sat in a section headed
 * "Recent Releases".
 *
 * The split is on the date, not `releases.status`: this window is defined by dates, and a row
 * dated next month is upcoming whatever a status column nothing keeps ticking over happens to
 * say. Today counts as recent — it *is* out.
 *
 * Upcoming stays ascending, so its cap trims the furthest-off rather than the imminent; recent
 * flips to descending, so its cap trims the oldest rather than the news. Sorted on the ISO date
 * string, which compares correctly without parsing.
 */
export function splitRecentReleases(
  rows: FeedReleaseRow[],
  now: Date = new Date(),
  limit = RECENT_RELEASE_LIMIT
) {
  const today = now.toISOString().slice(0, 10);

  const upcoming = rows.filter(r => r.releaseDate > today);
  const recent = rows.filter(r => r.releaseDate <= today);

  return {
    upcoming: [...upcoming]
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
      .slice(0, limit)
      .map(toShortlistRow),
    recent: [...recent]
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
      .slice(0, limit)
      .map(toShortlistRow),
  };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}): Promise<JsonResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // One verification, not two: deriving the rate-limit bucket already checked the token
  // (see resolveAccountRequest), so the user it found is the user this handler uses.
  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as JsonResponse;

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  const rows = await getFeedReleasesForUser(user.userId);

  return {
    statusCode: 200,
    // One fan's saved artists — never cached by anything shared, the same rule the private feed
    // follows.
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(splitRecentReleases(rows)),
  };
}
