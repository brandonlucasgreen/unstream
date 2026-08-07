// API endpoint: /api/me/recent-releases
//
// GET — a shortlist of recent and upcoming releases by the signed-in fan's saved artists, for
// the "Recent Releases" section of /dashboard.
//
// Follows the same conventions as the other me-* endpoints (bearer auth against the anon client,
// hand-rolled permissive CORS) and is in api/tsconfig.json's typecheck include — keep it there.

import { createClient } from '@supabase/supabase-js';
import { getFeedReleasesForUser, type FeedReleaseRow } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/**
 * How many rows the dashboard shows. A shortlist, not a list: the section sits beside Saved
 * Artists and exists to say "here is what's new", so it has to stay glanceable. Six fills three
 * rows of the two-column grid.
 */
export const RECENT_RELEASE_LIMIT = 6;

/** One response shape for every path, so callers (and tests) don't have to narrow a union. */
interface JsonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function authenticateRequest(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * Newest first, then capped.
 *
 * `getFeedReleasesForUser` returns the same window ascending, because a calendar and a reader
 * both want the *next* thing at the top. A dashboard shortlist wants the opposite: descending
 * puts anything still to come above everything already out, and then the most recent release
 * above older ones — so the cap trims the oldest rather than silently dropping the news.
 *
 * Sorted on the ISO date string, which compares correctly without parsing.
 */
export function toRecentReleases(rows: FeedReleaseRow[], limit = RECENT_RELEASE_LIMIT) {
  return [...rows]
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
    .slice(0, limit)
    .map(row => ({
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
    }));
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}): Promise<JsonResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const rl = await checkRateLimit(getClientIp(event.headers), 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response as JsonResponse;

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const userId = await authenticateRequest(event.headers.authorization);
  if (!userId) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  const rows = await getFeedReleasesForUser(userId);

  return {
    statusCode: 200,
    // One fan's saved artists — never cached by anything shared, the same rule the private feed
    // follows.
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' },
    body: JSON.stringify({ releases: toRecentReleases(rows) }),
  };
}
