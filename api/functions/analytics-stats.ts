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

  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  // Authenticate
  const auth = await authenticateRequest(event.headers?.authorization || event.headers?.Authorization);
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

  // Resolve artist and verify ownership
  const { data: artist } = await client
    .from('artists')
    .select('id')
    .eq('slug', slug)
    .single();

  if (!artist) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist not found' }) };
  }

  const { data: profile } = await client
    .from('artist_profiles')
    .select('id')
    .eq('artist_id', artist.id)
    .eq('user_id', auth.userId)
    .not('verified_at', 'is', null)
    .single();

  if (!profile) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authorized to view analytics for this artist' }) };
  }

  // Query analytics
  let query = client
    .from('artist_analytics')
    .select('date, metric, count')
    .eq('artist_id', artist.id);

  if (period !== 'all') {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = new Date();
    since.setDate(since.getDate() - days);
    query = query.gte('date', since.toISOString().split('T')[0]);
  }

  const { data: rows, error: queryError } = await query.order('date', { ascending: true });

  if (queryError) {
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
