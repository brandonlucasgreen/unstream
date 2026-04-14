// GET /api/analytics/dashboard
// Admin-only endpoint returning aggregated product analytics for the dashboard.

import { getClient } from './db';
import { authenticateAdmin } from './middleware';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}) {
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
    // Run all queries in parallel
    const [
      searchesToday,
      searches7d,
      searches30d,
      successfulSearches7d,
      daily30d,
      byApp30d,
      platforms30d,
      streamingServices30d,
      recentEvents,
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

      // Searches with known outcome (has_results field present) last 7 days
      // We fire two 'search' events: one on initiation (no has_results) and one on completion.
      // Only completed searches count toward success rate.
      client
        .from('app_events')
        .select('context')
        .eq('event_type', 'search')
        .not('context->>has_results', 'is', null)
        .gte('created_at', ago7),

      // Daily event counts for last 30 days (searches + clicks)
      client
        .from('app_events')
        .select('created_at, event_type')
        .in('event_type', ['search', 'platform_click', 'extension_activated'])
        .gte('created_at', ago30)
        .order('created_at', { ascending: true }),

      // Breakdown by app (last 30 days)
      client
        .from('app_events')
        .select('app, event_type')
        .in('event_type', ['search', 'platform_click'])
        .gte('created_at', ago30),

      // Platform click breakdown (last 30 days)
      client
        .from('app_events')
        .select('context')
        .eq('event_type', 'platform_click')
        .gte('created_at', ago30),

      // Extension streaming service breakdown (last 30 days)
      client
        .from('app_events')
        .select('context')
        .eq('event_type', 'extension_activated')
        .gte('created_at', ago30),

      // Recent 20 events
      client
        .from('app_events')
        .select('event_type, app, context, created_at')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    // Surface query errors early — Supabase returns { error } rather than throwing
    const queryErrors = [
      searchesToday.error, searches7d.error, searches30d.error,
      successfulSearches7d.error, daily30d.error,
    ].filter(Boolean);
    if (queryErrors.length > 0) {
      console.error('[Analytics Dashboard] Query errors:', queryErrors.map(e => e?.message));
      // If the core count queries all errored (e.g. app_events table missing), surface it
      if (queryErrors.length >= 3) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Analytics table unavailable — migration may not have been applied' }) };
      }
    }

    // --- Build daily chart data (last 30 days) ---
    const dailyMap: Record<string, { searches: number; clicks: number; activations: number }> = {};

    // Pre-fill all 30 days
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      dailyMap[dateStr] = { searches: 0, clicks: 0, activations: 0 };
    }

    for (const row of (daily30d.data || [])) {
      const dateStr = row.created_at.split('T')[0];
      if (!dailyMap[dateStr]) continue;
      if (row.event_type === 'search') dailyMap[dateStr].searches++;
      else if (row.event_type === 'platform_click') dailyMap[dateStr].clicks++;
      else if (row.event_type === 'extension_activated') dailyMap[dateStr].activations++;
    }

    const daily = Object.entries(dailyMap).map(([date, counts]) => ({ date, ...counts }));

    // --- By app breakdown ---
    const appMap: Record<string, { searches: number; clicks: number }> = {
      web: { searches: 0, clicks: 0 },
      extension: { searches: 0, clicks: 0 },
      mac: { searches: 0, clicks: 0 },
    };
    for (const row of (byApp30d.data || [])) {
      if (!appMap[row.app]) appMap[row.app] = { searches: 0, clicks: 0 };
      if (row.event_type === 'search') appMap[row.app].searches++;
      else if (row.event_type === 'platform_click') appMap[row.app].clicks++;
    }
    const byApp = Object.entries(appMap)
      .map(([app, counts]) => ({ app, ...counts }))
      .sort((a, b) => (b.searches + b.clicks) - (a.searches + a.clicks));

    // --- Platform breakdown ---
    const platformMap: Record<string, number> = {};
    for (const row of (platforms30d.data || [])) {
      const platform = (row.context as Record<string, string>)?.platform;
      if (platform) platformMap[platform] = (platformMap[platform] || 0) + 1;
    }
    const platforms = Object.entries(platformMap)
      .map(([platform, clicks]) => ({ platform, clicks }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 10);

    // --- Streaming service breakdown ---
    const serviceMap: Record<string, number> = {};
    for (const row of (streamingServices30d.data || [])) {
      const service = (row.context as Record<string, string>)?.streaming_service;
      if (service) serviceMap[service] = (serviceMap[service] || 0) + 1;
    }
    const streamingServices = Object.entries(serviceMap)
      .map(([service, activations]) => ({ service, activations }))
      .sort((a, b) => b.activations - a.activations);

    // --- Success rate ---
    // Only count searches where we received a result (has_results field present).
    // Initiation events (no has_results) are excluded from both numerator and denominator.
    const completedSearchRows = (successfulSearches7d.data || []) as Array<{ context: Record<string, unknown> }>;
    const completedCount = completedSearchRows.length;
    const successCount = completedSearchRows.filter(r => r.context?.has_results === true).length;
    const successRate7d = completedCount > 0
      ? Math.round((successCount / completedCount) * 100)
      : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        summary: {
          searches_today: searchesToday.count || 0,
          searches_7d: totalSearches7d,
          searches_30d: searches30d.count || 0,
          success_rate_7d: successRate7d,
          top_platform: platforms[0]?.platform || null,
          top_streaming_service: streamingServices[0]?.service || null,
        },
        daily,
        by_app: byApp,
        platforms,
        streaming_services: streamingServices,
        recent: (recentEvents.data || []).map(e => ({
          event_type: e.event_type,
          app: e.app,
          context: e.context,
          created_at: e.created_at,
        })),
      }),
    };
  } catch (err) {
    console.error('[Analytics Dashboard] Error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch analytics' }) };
  }
}
