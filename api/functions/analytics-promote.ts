// GET /api/analytics/promote
// Admin-only: how many artists use Promote right now, for /admin/analytics. Three counts:
//
// - autopost: artists with release autopost switched on (release_autopost_settings.enabled),
//   and how many of those the sweep has paused on its own (paused_reason, e.g. a Buffer login
//   that ended), since those are switched on but not posting.
// - campaigns: release campaigns running right now, and how many artists they belong to.
//   "Running" is the planner's definition (campaignsForPlan in release-campaigns-db.ts): not
//   cancelled, with at least one post dated today or later. A campaign whose last post has gone
//   stays `active` in the table until it's cancelled, so status alone would count finished ones.
//
// A snapshot, not a range: the page's date range doesn't apply, and nothing here is stored over
// time. Its own endpoint, like analytics-traffic.ts, so a failure here can't blank the search
// numbers. Not cached: two small reads per admin page load.
//
// "Today" is the UTC date. Campaign post dates are the artist's local days, so a campaign whose
// last post is today in a timezone behind UTC can drop out a few hours early. Close enough for a
// usage count.

import { getClient, readAllPages } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';

interface SettingsRow { artist_id: string; paused_reason: string | null }
interface CampaignRow { id: string; artist_id: string }

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
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

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const today = new Date().toISOString().slice(0, 10);

  const [settings, campaigns] = await Promise.all([
    readAllPages<SettingsRow>(
      (from, to) => client
        .from('release_autopost_settings')
        .select('artist_id, paused_reason')
        .eq('enabled', true)
        .order('artist_id')
        .range(from, to),
      'release_autopost_settings'
    ),
    // The inner join keeps only campaigns with a post on or after today; the posts themselves
    // are only there to filter on.
    readAllPages<CampaignRow>(
      (from, to) => client
        .from('release_campaigns')
        .select('id, artist_id, release_campaign_posts!inner ( post_date )')
        .eq('status', 'active')
        .gte('release_campaign_posts.post_date', today)
        .order('id')
        .range(from, to),
      'release_campaigns'
    ),
  ]);

  // Wrong numbers are worse than none (analytics-dashboard.ts): a failed read is an error, not a zero.
  if (!settings.ok || !campaigns.ok) {
    const reasons = [settings, campaigns].flatMap(r => (r.ok ? [] : [r.reason])).join('; ');
    Sentry.captureMessage('Promote analytics query failed', {
      level: 'error',
      extra: { reasons },
      tags: { context: 'analytics.promote' },
    });
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch Promote usage' }) };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      autopost: {
        enabled: settings.rows.length,
        paused: settings.rows.filter(r => r.paused_reason !== null).length,
      },
      campaigns: {
        running: campaigns.rows.length,
        artists: new Set(campaigns.rows.map(r => r.artist_id)).size,
      },
    }),
  };
}

export const handler = withSentry(handleRequest);
