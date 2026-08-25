// GET /api/analytics/dashboard
// Admin-only endpoint returning aggregated product analytics for the dashboard.

import { getClient } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry } from '../lib/sentry';

// Row shapes returned by the analytics_* functions added in
// supabase/migrations/20260823120000_analytics-dashboard-aggregates.sql.
interface DailyRow { day: string; event_type: string; events: number }
interface ByAppRow { app: string; event_type: string; events: number }
interface PlatformRow { platform: string; clicks: number }
interface StreamingRow { service: string; activations: number }
interface SuccessRow { completed: number; with_results: number }

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}) {
  // Restricted to unstream.stream like every other admin endpoint. The '*' this used
  // to send wasn't exploitable — a cross-origin page can't get the bearer token — but
  // it read as though permissive CORS were intended here, which it isn't.
  const origin = event.headers['origin'] || event.headers['Origin'];
  const CORS_HEADERS = buildCorsHeaders(origin, false);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization']);
  if (!admin) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const ago7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const ago30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = `${today}T00:00:00.000Z`;

  try {
    // Every aggregate is computed in Postgres. It used to pull raw app_events rows and count
    // them in a JS loop, which PostgREST silently truncated at 1,000 rows — the dashboard
    // reported 641 of 10,380 searches, and because the daily query ordered created_at ASC the
    // surviving rows were the oldest, so the most recent 26 days rendered as zero. See
    // supabase/migrations/20260823120000_analytics-dashboard-aggregates.sql.
    const [
      searchesToday,
      searches7d,
      searches30d,
      searchSuccess7d,
      daily30d,
      byApp30d,
      platforms30d,
      streamingServices30d,
    ] = await Promise.all([
      // Searches today
      client
        .from('app_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'search')
        .gte('created_at', todayStart),

      // Searches last 7 days
      client
        .from('app_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'search')
        .gte('created_at', ago7),

      // Searches last 30 days
      client
        .from('app_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'search')
        .gte('created_at', ago30),

      // Completed searches and how many found something, last 7 days. Searches from before
      // 2026-08-19 wrote a second, context-free initiation event per query; the function counts
      // only events carrying a has_results key, so those sit outside both sides of the ratio.
      // That is why search counts stepped down (and became accurate) on that date.
      client.rpc('analytics_search_success', { p_since: ago7 }),

      // Daily event counts for last 30 days (searches + clicks + activations)
      client.rpc('analytics_daily_events', { p_since: ago30 }),

      // Breakdown by app (last 30 days)
      client.rpc('analytics_events_by_app', { p_since: ago30 }),

      // Platform click breakdown (last 30 days), most-clicked first
      client.rpc('analytics_platform_clicks', { p_since: ago30 }),

      // Extension streaming service breakdown (last 30 days), most-active first
      client.rpc('analytics_streaming_services', { p_since: ago30 }),
    ]);

    // Any failure fails the whole response. Supabase returns { error } rather than throwing, and
    // the old code logged a partial failure and carried on — which is how a dashboard ends up
    // rendering confident zeros for a query that never ran. Wrong numbers are worse here than
    // no numbers: these drive product decisions.
    const queryErrors = [
      searchesToday.error, searches7d.error, searches30d.error, searchSuccess7d.error,
      daily30d.error, byApp30d.error, platforms30d.error, streamingServices30d.error,
    ].filter(Boolean);
    if (queryErrors.length > 0) {
      const messages = queryErrors.map(e => e?.message).join('; ');
      console.error('[Analytics Dashboard] Query errors:', messages);
      Sentry.captureMessage('Analytics dashboard query failed', {
        level: 'error',
        extra: { messages, failed: queryErrors.length },
        tags: { context: 'analytics.dashboard' },
      });
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to fetch analytics' }),
      };
    }

    // --- Build daily chart data (last 30 days) ---
    const dailyMap: Record<string, { searches: number; clicks: number; activations: number }> = {};

    // Pre-fill all 30 days
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      dailyMap[dateStr] = { searches: 0, clicks: 0, activations: 0 };
    }

    // `day` is a Postgres DATE, so it arrives as a bare 'YYYY-MM-DD' string — the same shape
    // the pre-filled keys above use.
    for (const row of (daily30d.data || []) as DailyRow[]) {
      const bucket = dailyMap[row.day];
      if (!bucket) continue;
      if (row.event_type === 'search') bucket.searches += row.events;
      else if (row.event_type === 'platform_click') bucket.clicks += row.events;
      else if (row.event_type === 'extension_activated') bucket.activations += row.events;
    }

    const daily = Object.entries(dailyMap).map(([date, counts]) => ({ date, ...counts }));

    // --- By app breakdown ---
    const appMap: Record<string, { searches: number; clicks: number }> = {
      web: { searches: 0, clicks: 0 },
      extension: { searches: 0, clicks: 0 },
      mac: { searches: 0, clicks: 0 },
    };
    for (const row of (byApp30d.data || []) as ByAppRow[]) {
      if (!appMap[row.app]) appMap[row.app] = { searches: 0, clicks: 0 };
      if (row.event_type === 'search') appMap[row.app].searches += row.events;
      else if (row.event_type === 'platform_click') appMap[row.app].clicks += row.events;
    }
    const byApp = Object.entries(appMap)
      .map(([app, counts]) => ({ app, ...counts }))
      .sort((a, b) => (b.searches + b.clicks) - (a.searches + a.clicks));

    // --- Platform breakdown ---
    // Already grouped and ordered most-clicked first by the function.
    const platforms = ((platforms30d.data || []) as PlatformRow[]).slice(0, 10);

    // --- Streaming service breakdown ---
    const streamingServices = (streamingServices30d.data || []) as StreamingRow[];

    // --- Success rate ---
    const success = ((searchSuccess7d.data || []) as SuccessRow[])[0];
    const successRate7d = success && success.completed > 0
      ? Math.round((success.with_results / success.completed) * 100)
      : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        summary: {
          searches_today: searchesToday.count || 0,
          searches_7d: searches7d.count || 0,
          searches_30d: searches30d.count || 0,
          success_rate_7d: successRate7d,
          top_platform: platforms[0]?.platform || null,
          top_streaming_service: streamingServices[0]?.service || null,
        },
        daily,
        by_app: byApp,
        platforms,
        streaming_services: streamingServices,
      }),
    };
  } catch (err) {
    console.error('[Analytics Dashboard] Error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch analytics' }) };
  }
}
