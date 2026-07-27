// GET /api/analytics/stats?slug={slug}&period=7d|30d|90d|all
// Authenticated endpoint returning aggregated analytics for a verified artist.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_PERIODS = new Set(['7d', '30d', '90d', 'all']);

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string>;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Rate-limit check (Redis) and token validation (Supabase Auth) are both
  // network round-trips with no data dependency — run them concurrently.
  const ip = getClientIp(event.headers || {});
  const rlPromise = checkRateLimit(ip, 'standard', CORS_HEADERS);
  const authPromise = authenticateRequest(event.headers?.authorization || event.headers?.Authorization).catch(() => null);
  const rl = await rlPromise;
  if (rl.limited) return rl.response;

  const auth = await authPromise;
  if (!auth) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Parse params
  const slug = event.queryStringParameters?.slug;
  const period = event.queryStringParameters?.period || '30d';

  if (!slug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'slug parameter required' }) };
  }
  if (!VALID_PERIODS.has(period)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid period. Use 7d, 30d, 90d, or all' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // Resolve artist and verify ownership. The two lookups are independent —
  // the ownership check joins artists by slug via the artist_id FK — so they
  // run in parallel instead of back-to-back. 404 (no artist) still takes
  // precedence over 403 (not the owner).
  const [{ data: artist }, { data: profile }] = await Promise.all([
    client
      .from('artists')
      .select('id')
      .eq('slug', slug)
      .single(),
    client
      .from('artist_profiles')
      .select('id, artists!inner(id)')
      .eq('user_id', auth.userId)
      .eq('artists.slug', slug)
      .not('verified_at', 'is', null)
      .maybeSingle(),
  ]);

  if (!artist) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist not found' }) };
  }

  if (!profile) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authorized to view analytics for this artist' }) };
  }

  // Query analytics via SECURITY DEFINER RPC to bypass RLS
  let sinceDate = '1970-01-01';
  if (period !== 'all') {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = new Date();
    since.setDate(since.getDate() - days);
    sinceDate = since.toISOString().split('T')[0];
  }

  const { data: rows, error: queryError } = await client.rpc('get_artist_analytics', {
    p_artist_id: artist.id,
    p_since: sinceDate,
  });

  if (queryError) {
    console.error('[analytics-stats] RPC error:', queryError.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch analytics' }) };
  }

  // Aggregate
  let totalSearches = 0;
  let totalViews = 0;
  let totalClicks = 0;
  const clicksByPlatform: Record<string, number> = {};
  const dailyMap = new Map<string, { searches: number; views: number; clicks: number }>();

  for (const row of rows || []) {
    const day = dailyMap.get(row.date) || { searches: 0, views: 0, clicks: 0 };

    if (row.metric === 'search') {
      totalSearches += row.count;
      day.searches += row.count;
    } else if (row.metric === 'view') {
      totalViews += row.count;
      day.views += row.count;
    } else if (row.metric.startsWith('click:')) {
      const platform = row.metric.slice(6);
      totalClicks += row.count;
      day.clicks += row.count;
      clicksByPlatform[platform] = (clicksByPlatform[platform] || 0) + row.count;
    }

    dailyMap.set(row.date, day);
  }

  const daily = Array.from(dailyMap.entries()).map(([date, stats]) => ({
    date,
    ...stats,
  }));

  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'private, max-age=60',
    },
    body: JSON.stringify({
      period,
      totals: {
        searches: totalSearches,
        views: totalViews,
        clicks: totalClicks,
      },
      clicksByPlatform,
      daily,
    }),
  };
}
