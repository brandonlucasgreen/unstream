// GET /api/analytics/stats?slug={slug}&period=7d|30d|90d|all
// Authenticated endpoint returning aggregated analytics for a verified artist: the totals for the
// period, and the activity list for the last 90 days whatever the period (artist-activity.ts).
// Behind /analytics/:slug.

import { withSentry, Sentry } from '../lib/sentry';
import { getClient, readAllPages } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { authenticateBearerFast } from './middleware';
import { isLiveMode } from './stripe';
import { keptAfterRefund } from '../shared/tips';
import { buildActivity, summarizeAnalytics, RELEASE_VIEW_PREFIX, type AnalyticsRow } from './artist-activity';

/** How far back the activity list reaches, whatever period the totals cover. */
const ACTIVITY_DAYS = 90;

const isoDay = (daysAgo: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
};

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_PERIODS = new Set(['7d', '30d', '90d', 'all']);

async function handleRequest(event: {
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
  const authPromise = authenticateBearerFast(event.headers?.authorization || event.headers?.Authorization).catch(() => null);
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
      .select('id, name')
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

  const periodSince = period === 'all'
    ? '1970-01-01'
    : isoDay(period === '7d' ? 7 : period === '30d' ? 30 : 90);
  const activitySince = isoDay(ACTIVITY_DAYS);
  const readSince = periodSince < activitySince ? periodSince : activitySince;

  try {
    // Paged: PostgREST caps a response at 1,000 rows without saying so, and a busy artist's
    // daily rows (one per metric, release and platform) pass that well inside "all time".
    const [analyticsRead, savesRead, collectedRead, tipsRead, alertsRead] = await Promise.all([
      readAllPages<AnalyticsRow>(
        (from, to) => client.rpc('get_artist_analytics', { p_artist_id: artist.id, p_since: readSince }).range(from, to),
        'artist analytics',
      ),
      // Every current save, not just recent ones: the all-time fan count comes from here, and a
      // supported mark can land on a save from months ago.
      client
        .from('saved_artists')
        .select('added_at, supported, supported_at')
        .eq('artist_id', artist.id)
        .eq('deleted', false),
      // Hidden items stay out: the fan chose not to show them.
      client
        .from('collection_items')
        .select('created_at, releases!inner(artist_id, title)')
        .eq('releases.artist_id', artist.id)
        .eq('hidden', false)
        .gte('created_at', activitySince),
      client
        .from('tip_payments')
        .select('created_at, amount_cents, gross_cents, refunded_cents')
        .eq('artist_id', artist.id)
        .eq('livemode', isLiveMode())
        // Refunded rows can still carry a partial amount the artist kept; disputed money may yet
        // go back, so it isn't counted until the dispute is won (status returns to succeeded).
        .in('status', ['succeeded', 'refunded'])
        .gte('created_at', activitySince),
      // notifySavedArtistsOfNewRelease keys each alert `${artistId}:${lowest release id}`.
      client
        .from('email_log')
        .select('reference_id, created_at')
        .eq('notification_type', 'new_release')
        .eq('status', 'sent')
        .like('reference_id', `${artist.id}:%`)
        .gte('created_at', activitySince),
    ]);

    if (!analyticsRead.ok) throw new Error(analyticsRead.reason);
    for (const read of [savesRead, collectedRead, tipsRead, alertsRead]) {
      if (read.error) throw new Error(read.error.message);
    }

    const analytics = analyticsRead.rows;
    const summary = summarizeAnalytics(analytics, periodSince);

    // One alert is one reference id; its recipients are its rows.
    const alertsByRef = new Map<string, { sentAt: string; releaseId: string; recipients: number }>();
    for (const row of (alertsRead.data ?? []) as Array<{ reference_id: string; created_at: string }>) {
      const existing = alertsByRef.get(row.reference_id);
      if (existing) {
        existing.recipients += 1;
        if (row.created_at < existing.sentAt) existing.sentAt = row.created_at;
      } else {
        alertsByRef.set(row.reference_id, {
          sentAt: row.created_at,
          releaseId: row.reference_id.slice(artist.id.length + 1),
          recipients: 1,
        });
      }
    }

    // Titles for the release views and the alerts, in one read. Only this artist's releases, so
    // a stray id in a metric can't surface another artist's title.
    const releaseIds = [...new Set([
      ...analytics.filter(r => r.metric.startsWith(RELEASE_VIEW_PREFIX)).map(r => r.metric.slice(RELEASE_VIEW_PREFIX.length)),
      ...[...alertsByRef.values()].map(a => a.releaseId),
    ])];
    const releaseTitles: Record<string, string> = {};
    const releaseSlugs: Record<string, string> = {};
    if (releaseIds.length > 0) {
      const { data: releases, error: releasesError } = await client
        .from('releases')
        .select('id, title, slug')
        .eq('artist_id', artist.id)
        .in('id', releaseIds);
      if (releasesError) throw new Error(releasesError.message);
      for (const release of (releases ?? []) as Array<{ id: string; title: string; slug: string }>) {
        releaseTitles[release.id] = release.title;
        releaseSlugs[release.id] = release.slug;
      }
    }

    const saves = ((savesRead.data ?? []) as Array<{ added_at: string | null; supported: boolean | null; supported_at: string | null }>)
      .map(s => ({ addedAt: s.added_at, supported: !!s.supported, supportedAt: s.supported_at }));

    const activity = buildActivity({
      analytics,
      saves,
      collected: ((collectedRead.data ?? []) as Array<{ created_at: string; releases: { title: string } | { title: string }[] }>)
        .map(item => ({
          createdAt: item.created_at,
          title: (Array.isArray(item.releases) ? item.releases[0]?.title : item.releases?.title) ?? '',
        }))
        .filter(item => item.title),
      tips: ((tipsRead.data ?? []) as Array<{ created_at: string; amount_cents: number; gross_cents: number; refunded_cents: number | null }>)
        .map(tip => ({
          createdAt: tip.created_at,
          keptCents: keptAfterRefund(tip.amount_cents, tip.gross_cents, tip.refunded_cents ?? 0),
        })),
      alerts: [...alertsByRef.values()]
        .filter(alert => releaseTitles[alert.releaseId])
        .map(alert => ({ sentAt: alert.sentAt, release: releaseTitles[alert.releaseId], recipients: alert.recipients })),
      releaseTitles,
      since: activitySince,
    });

    const releaseViews = Object.entries(summary.releaseViewsById)
      .filter(([id]) => releaseTitles[id])
      .map(([id, views]) => ({ title: releaseTitles[id], slug: releaseSlugs[id], views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'private, max-age=60',
      },
      body: JSON.stringify({
        artistName: artist.name,
        period,
        totals: summary.totals,
        // All-time, not the period's: how many fans follow you now.
        fans: {
          saved: saves.length,
          supported: saves.filter(s => s.supported).length,
        },
        clicksByPlatform: summary.clicksByPlatform,
        releaseViews,
        daily: summary.daily,
        activity,
      }),
    };
  } catch (err) {
    Sentry.captureException(err, { extra: { context: 'analytics-stats', slug, period } });
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch analytics' }) };
  }
}

export const handler = withSentry(handleRequest);
