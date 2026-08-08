// Scheduled job: a weekly analytics recap email for every claimed, verified artist profile
// that hasn't opted out. Invoked by .github/workflows/weekly-analytics-recap.yml, the same
// GitHub Actions cron pattern as recatalog-sweep.ts — there are no scheduled Netlify functions
// in this repo.
//
// Reuses the same tables the artist-facing dashboard reads (api/functions/analytics-stats.ts)
// rather than its RPC — this runs with the service-role client, which bypasses RLS, so a
// direct read of artist_analytics needs no RPC wrapper.

import { getClient } from './db';
import { isInternalRequest } from './middleware';
import { sendNotificationOnce, filterByPreference } from './notifications';
import { escapeHtml } from '../lib/html';
import { Sentry } from '../lib/sentry';

const RECAP_WINDOW_DAYS = 7;

/** The Monday (UTC) on or before `date`, as YYYY-MM-DD — the recap's dedup key for "this week". */
function weekStartKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

interface VerifiedProfileRow {
  artist_id: string;
  user_id: string;
  email: string;
  artists: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

interface AnalyticsRow {
  metric: string;
  count: number;
}

function summarize(rows: AnalyticsRow[]): { searches: number; views: number; clicks: number } {
  let searches = 0, views = 0, clicks = 0;
  for (const row of rows) {
    if (row.metric === 'search') searches += row.count;
    else if (row.metric === 'view') views += row.count;
    else if (row.metric.startsWith('click:')) clicks += row.count;
  }
  return { searches, views, clicks };
}

export async function handler(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!isInternalRequest(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const { data: profiles, error: profilesError } = await client
    .from('artist_profiles')
    .select('artist_id, user_id, email, artists(name, slug)')
    .not('verified_at', 'is', null);

  if (profilesError) {
    Sentry.captureMessage('[weekly-analytics-recap] could not load verified profiles', {
      level: 'error',
      extra: { error: profilesError.message },
    });
    return { statusCode: 503, body: JSON.stringify({ error: profilesError.message }) };
  }

  const rows = (profiles || []) as VerifiedProfileRow[];
  if (rows.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, skipped: 0, optedOut: 0 }) };
  }

  const enabledUserIds = new Set(
    await filterByPreference(client, rows.map(r => r.user_id), 'weekly_analytics_recap'),
  );

  const since = new Date(Date.now() - RECAP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekKey = weekStartKey(new Date());

  let sent = 0;
  let skipped = 0;
  let optedOut = 0;

  for (const row of rows) {
    if (!enabledUserIds.has(row.user_id)) {
      optedOut++;
      continue;
    }

    const artist = Array.isArray(row.artists) ? row.artists[0] : row.artists;
    if (!artist?.slug || !row.email) {
      skipped++;
      continue;
    }

    const { data: analyticsRows, error: analyticsError } = await client
      .from('artist_analytics')
      .select('metric, count')
      .eq('artist_id', row.artist_id)
      .gte('date', since);

    if (analyticsError) {
      Sentry.captureException(analyticsError, {
        extra: { context: 'weekly-analytics-recap.analytics', artistId: row.artist_id },
      });
      skipped++;
      continue;
    }

    const { searches, views, clicks } = summarize((analyticsRows || []) as AnalyticsRow[]);
    const profileUrl = `https://unstream.stream/a/${artist.slug}`;

    await sendNotificationOnce({
      client,
      notificationType: 'weekly_analytics_recap',
      referenceId: `${row.artist_id}:${weekKey}`,
      recipientEmail: row.email,
      subject: `Your week on Unstream: ${searches + views} looks, ${clicks} link clicks`,
      html: `<p>Here's how <strong>${escapeHtml(artist.name)}</strong> did on Unstream over the last 7 days:</p>
<ul>
  <li>${searches} search appearances</li>
  <li>${views} profile views</li>
  <li>${clicks} link clicks</li>
</ul>
<p>See the full breakdown on your <a href="${profileUrl}">artist dashboard</a>.</p>`,
      text: `Here's how ${artist.name} did on Unstream over the last 7 days:\n\n- ${searches} search appearances\n- ${views} profile views\n- ${clicks} link clicks\n\nSee the full breakdown on your artist dashboard: ${profileUrl}`,
    });
    sent++;
  }

  return { statusCode: 200, body: JSON.stringify({ sent, skipped, optedOut }) };
}
