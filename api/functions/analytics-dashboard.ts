// GET /api/analytics/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
// Admin-only endpoint returning aggregated product analytics for the dashboard. Without a range
// it reports the last 30 days (analytics-range.ts).

import { getClient } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { bucketStart, datesInRange, parseAnalyticsRange } from './analytics-range';
import { Sentry, withSentry } from '../lib/sentry';

// Row shapes returned by the analytics_* functions in
// supabase/migrations/20261027120000_analytics-date-ranges.sql.
interface DailyRow { day: string; event_type: string; events: number }
interface ByAppRow { app: string; event_type: string; events: number }
interface ContextRow { event_type: string; app: string; value: string; events: number }
interface SuccessRow { completed: number; with_results: number }

const APPS = ['web', 'extension', 'mac'];
const BROWSERS = ['chrome', 'firefox'];

/** Sums `events` for the rows matching every given field. */
function sumWhere(rows: ContextRow[], match: Partial<ContextRow>): number {
  return rows
    .filter(row => Object.entries(match).every(([k, v]) => row[k as keyof ContextRow] === v))
    .reduce((n, row) => n + row.events, 0);
}

/** One value's total across apps, most first. The functions group by app too. */
function totalsByValue(rows: ContextRow[]): { value: string; events: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.value, (totals.get(row.value) || 0) + row.events);
  return [...totals].map(([value, events]) => ({ value, events })).sort((a, b) => b.events - a.events);
}

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
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

  const range = parseAnalyticsRange(event.queryStringParameters);
  if ('error' in range) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: range.error }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const bounds = { p_since: range.since, p_until: range.until };

  try {
    // Every aggregate is computed in Postgres. It used to pull raw app_events rows and count
    // them in a JS loop, which PostgREST silently truncated at 1,000 rows — the dashboard
    // reported 641 of 10,380 searches, and because the daily query ordered created_at ASC the
    // surviving rows were the oldest, so the most recent 26 days rendered as zero. See
    // supabase/migrations/20260823120000_analytics-dashboard-aggregates.sql.
    //
    // The search total is the sum of the daily counts rather than a separate count query: a
    // direct count of app_events sees only the last 90 days, because older rows live in the
    // app_events_daily rollup, which the functions read and a count can't.
    const [daily, byApp, success, platforms, streamingServices, browsers, searchKinds] = await Promise.all([
      client.rpc('analytics_daily_events', bounds),
      client.rpc('analytics_events_by_app', bounds),
      // Searches from before 2026-08-19 wrote a second, context-free initiation event per
      // query; the function counts only events carrying a has_results key, so those sit outside
      // both sides of the ratio.
      client.rpc('analytics_search_success', bounds),
      client.rpc('analytics_context_counts', { ...bounds, p_event_types: ['platform_click'], p_key: 'platform' }),
      client.rpc('analytics_context_counts', { ...bounds, p_event_types: ['extension_activated'], p_key: 'streaming_service' }),
      client.rpc('analytics_context_counts', { ...bounds, p_event_types: ['search', 'platform_click'], p_key: 'browser' }),
      client.rpc('analytics_context_counts', { ...bounds, p_event_types: ['search'], p_key: 'search_kind' }),
    ]);

    // Any failure fails the whole response. Supabase returns { error } rather than throwing, and
    // the old code logged a partial failure and carried on — which is how a dashboard ends up
    // rendering confident zeros for a query that never ran. Wrong numbers are worse here than
    // no numbers: these drive product decisions.
    const queryErrors = [daily, byApp, success, platforms, streamingServices, browsers, searchKinds]
      .map(result => result.error)
      .filter(Boolean);
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

    // --- Chart: one bar per day, or per week for long ranges ---
    // Every bucket is pre-filled so days without events render as zero rather than vanish.
    const buckets = new Map<string, { searches: number; clicks: number; activations: number }>();
    for (const date of datesInRange(range)) {
      const key = bucketStart(date, range);
      if (!buckets.has(key)) buckets.set(key, { searches: 0, clicks: 0, activations: 0 });
    }
    // `day` is a Postgres DATE, so it arrives as a bare 'YYYY-MM-DD' string.
    for (const row of (daily.data || []) as DailyRow[]) {
      const bucket = buckets.get(bucketStart(row.day, range));
      if (!bucket) continue;
      if (row.event_type === 'search') bucket.searches += row.events;
      else if (row.event_type === 'platform_click') bucket.clicks += row.events;
      else if (row.event_type === 'extension_activated') bucket.activations += row.events;
    }
    const chart = [...buckets].map(([date, counts]) => ({ date, ...counts }));
    const searches = chart.reduce((n, bucket) => n + bucket.searches, 0);

    // --- Clients: web, the extension per browser, Mac ---
    // Extension events gained a browser on 2.10. Older versions' events have none, and are
    // reported as their own row rather than guessed at.
    const appTotals: Record<string, { searches: number; clicks: number }> = {};
    for (const app of APPS) appTotals[app] = { searches: 0, clicks: 0 };
    for (const row of (byApp.data || []) as ByAppRow[]) {
      if (!appTotals[row.app]) appTotals[row.app] = { searches: 0, clicks: 0 };
      if (row.event_type === 'search') appTotals[row.app].searches += row.events;
      else if (row.event_type === 'platform_click') appTotals[row.app].clicks += row.events;
    }
    const browserRows = (browsers.data || []) as ContextRow[];
    const clients: { app: string; browser: string | null; searches: number; clicks: number }[] = [];
    for (const [app, totals] of Object.entries(appTotals)) {
      if (app !== 'extension') {
        clients.push({ app, browser: null, ...totals });
        continue;
      }
      let searchesLeft = totals.searches;
      let clicksLeft = totals.clicks;
      for (const browser of BROWSERS) {
        const browserSearches = sumWhere(browserRows, { app, value: browser, event_type: 'search' });
        const browserClicks = sumWhere(browserRows, { app, value: browser, event_type: 'platform_click' });
        clients.push({ app, browser, searches: browserSearches, clicks: browserClicks });
        searchesLeft -= browserSearches;
        clicksLeft -= browserClicks;
      }
      if (searchesLeft > 0 || clicksLeft > 0) {
        clients.push({ app, browser: 'unrecorded', searches: searchesLeft, clicks: clicksLeft });
      }
    }

    // --- Searches by kind: typed vs now playing, per app ---
    // Events from before each client sent search_kind are counted as `unlabelled`; for the
    // extension those are the old per-track counts.
    const kindRows = (searchKinds.data || []) as ContextRow[];
    const searchKindsByApp = Object.entries(appTotals).map(([app, totals]) => {
      const typed = sumWhere(kindRows, { app, value: 'typed' });
      const nowPlaying = sumWhere(kindRows, { app, value: 'now_playing' });
      return { app, typed, now_playing: nowPlaying, unlabelled: Math.max(0, totals.searches - typed - nowPlaying) };
    });

    // --- Platform and streaming service breakdowns ---
    const platformTotals = totalsByValue((platforms.data || []) as ContextRow[])
      .slice(0, 10)
      .map(({ value, events }) => ({ platform: value, clicks: events }));
    const serviceTotals = totalsByValue((streamingServices.data || []) as ContextRow[])
      .map(({ value, events }) => ({ service: value, activations: events }));

    // --- Success rate ---
    const successRow = ((success.data || []) as SuccessRow[])[0];
    const successRate = successRow && successRow.completed > 0
      ? Math.round((successRow.with_results / successRow.completed) * 100)
      : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        range: { from: range.from, to: range.to, days: range.days, granularity: range.granularity },
        summary: {
          searches,
          searches_per_day: Math.round(searches / range.days),
          success_rate: successRate,
          top_platform: platformTotals[0]?.platform || null,
          top_streaming_service: serviceTotals[0]?.service || null,
        },
        chart,
        clients,
        search_kinds: searchKindsByApp,
        platforms: platformTotals,
        streaming_services: serviceTotals,
      }),
    };
  } catch (err) {
    console.error('[Analytics Dashboard] Error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch analytics' }) };
  }
}

export const handler = withSentry(handleRequest);
