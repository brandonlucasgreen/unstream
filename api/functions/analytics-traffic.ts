// GET /api/analytics/traffic?from=YYYY-MM-DD&to=YYYY-MM-DD
// Admin-only: website traffic from GoatCounter for the same range as the search dashboard
// (analytics-range.ts), so /admin/analytics can show visitors beside searches.
//
// A separate endpoint from analytics-dashboard.ts on purpose: GoatCounter is a third party, and
// its being down or unconfigured must not take the search numbers with it. The page asks both
// at once and renders each on its own.
//
// Requires GOATCOUNTER_API_TOKEN, a token from GoatCounter's Settings → API with the "Read
// statistics" permission. Without it this answers `{ configured: false }` and the page says so.
//
// Not cached. It is three requests per admin page load, well inside GoatCounter's API limits,
// and caching it would spend metered Redis commands to save almost nothing.
//
// GoatCounter counts *visitors* (unique per page per day), not pageviews, and its daily
// series follows the GoatCounter site's own timezone setting, where app_events days are UTC.
// The range total is the UTC one (`total_utc`), so the headline matches the search range.

import { authenticateAdmin, buildCorsHeaders, isUrlHostnameAllowed } from './middleware';
import { bucketStart, datesInRange, parseAnalyticsRange, type AnalyticsRange } from './analytics-range';
import { Sentry, withSentry } from '../lib/sentry';

const GOATCOUNTER_API = 'https://unstream.goatcounter.com/api/v0';
const UPSTREAM_TIMEOUT_MS = 8000;
const TOP_LIMIT = 10;

// The fields we read of GoatCounter's responses (handlers/api.go in arp242/goatcounter).
interface TotalResponse {
  total_utc: number;
  stats: { day: string; daily: number }[];
}
interface HitsResponse {
  hits: { path: string; title: string; event: boolean; count: number }[];
}
interface RefsResponse {
  stats: { name: string; count: number }[];
}

async function goatcounter<T>(path: string, token: string): Promise<T> {
  const url = `${GOATCOUNTER_API}${path}`;
  if (!isUrlHostnameAllowed(url)) {
    throw new Error('GoatCounter host is not on the outbound allowlist');
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GoatCounter ${path.split('?')[0]} responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// The same buckets as the search chart (a day, or a week past 92 days), every one pre-filled so
// a day GoatCounter left out reads as zero rather than vanishing.
function visitorChart(range: AnalyticsRange, days: TotalResponse['stats']) {
  const buckets = new Map<string, number>();
  for (const date of datesInRange(range)) buckets.set(bucketStart(date, range), 0);
  for (const { day, daily } of days) {
    const key = bucketStart(day, range);
    if (buckets.has(key)) buckets.set(key, buckets.get(key)! + daily);
  }
  return [...buckets].map(([date, visitors]) => ({ date, visitors }));
}

async function fetchTraffic(range: AnalyticsRange, token: string) {
  // GoatCounter's end is inclusive, so the range ends on the last second of `to`.
  const params = new URLSearchParams({
    start: range.since,
    end: `${range.to}T23:59:59Z`,
  });
  const [total, hits, refs] = await Promise.all([
    goatcounter<TotalResponse>(`/stats/total?${params}`, token),
    // Twice the limit because events (the /go/… and /search counters the web app sends) are in
    // the same list as pages; they're filtered out below.
    goatcounter<HitsResponse>(`/stats/hits?${params}&limit=${TOP_LIMIT * 2}`, token),
    goatcounter<RefsResponse>(`/stats/toprefs?${params}&limit=${TOP_LIMIT}`, token),
  ]);

  return {
    configured: true as const,
    visitors: total.total_utc,
    chart: visitorChart(range, total.stats || []),
    top_pages: (hits.hits || [])
      .filter(h => !h.event)
      .slice(0, TOP_LIMIT)
      .map(h => ({ path: h.path, title: h.title, visitors: h.count })),
    // An empty name is GoatCounter's bucket for visits that sent no referrer.
    top_referrers: (refs.stats || []).map(r => ({ name: r.name || '(direct)', visitors: r.count })),
  };
}

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
}) {
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

  const token = process.env.GOATCOUNTER_API_TOKEN;
  if (!token) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ configured: false }) };
  }

  try {
    const traffic = await fetchTraffic(range, token);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(traffic) };
  } catch (err) {
    // Loud, not empty: a GoatCounter failure must read as "couldn't ask", never as zero visitors.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Analytics Traffic] GoatCounter failed:', message);
    Sentry.captureMessage('GoatCounter traffic fetch failed', {
      level: 'warning',
      extra: { message },
      tags: { context: 'analytics.traffic' },
    });
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'GoatCounter did not answer' }) };
  }
}

export const handler = withSentry(handleRequest);
