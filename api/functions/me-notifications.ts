// API endpoint: /api/me/notification-preferences
// GET  — returns the current user's toggles for saved-artist and analytics-recap emails.
// POST — updates one or more toggles. Body: { newRelease?, newPlatformLink?, weeklyAnalyticsRecap? }
//
// A user who has never touched these has no row in notification_preferences at all — GET
// reports that as all-true (the default) without creating one, and POST upserts a row only
// once they actually change something. Every sender (notifications.ts,
// weekly-analytics-recap.ts) treats a missing row the same way.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

const DEFAULT_PREFERENCES = {
  newRelease: true,
  newPlatformLink: true,
  weeklyAnalyticsRecap: true,
};

interface PreferencesRow {
  new_release: boolean;
  new_platform_link: boolean;
  weekly_analytics_recap: boolean;
}

function toResponseShape(row: PreferencesRow | null) {
  if (!row) return DEFAULT_PREFERENCES;
  return {
    newRelease: row.new_release,
    newPlatformLink: row.new_platform_link,
    weeklyAnalyticsRecap: row.weekly_analytics_recap,
  };
}

async function handleRequest({ method, user, body }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  if (method === 'GET') {
    const { data: row, error } = await client
      .from('notification_preferences')
      .select('new_release, new_platform_link, weekly_analytics_recap')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (error) {
      console.error('[me-notifications] Error fetching preferences:', error.message);
      return { status: 500, body: { error: 'Failed to load notification preferences' } };
    }

    return { status: 200, body: toResponseShape(row) };
  }

  // POST from here on: the wrapper has already refused every other method.
  const patch: Partial<PreferencesRow> = {};
  if ('newRelease' in body) {
    if (typeof body.newRelease !== 'boolean') {
      return { status: 400, body: { error: 'newRelease must be a boolean' } };
    }
    patch.new_release = body.newRelease;
  }
  if ('newPlatformLink' in body) {
    if (typeof body.newPlatformLink !== 'boolean') {
      return { status: 400, body: { error: 'newPlatformLink must be a boolean' } };
    }
    patch.new_platform_link = body.newPlatformLink;
  }
  if ('weeklyAnalyticsRecap' in body) {
    if (typeof body.weeklyAnalyticsRecap !== 'boolean') {
      return { status: 400, body: { error: 'weeklyAnalyticsRecap must be a boolean' } };
    }
    patch.weekly_analytics_recap = body.weeklyAnalyticsRecap;
  }

  if (Object.keys(patch).length === 0) {
    return { status: 400, body: { error: 'No recognized preference fields in body' } };
  }

  // Upsert: most users have no row yet. Unset fields fall back to the column default (true)
  // on first insert via onConflict merge semantics — an existing row keeps its other columns.
  const { data: row, error } = await client
    .from('notification_preferences')
    .upsert({ user_id: user.userId, ...patch }, { onConflict: 'user_id' })
    .select('new_release, new_platform_link, weekly_analytics_recap')
    .single();

  if (error) {
    console.error('[me-notifications] Error updating preferences:', error.message);
    return { status: 500, body: { error: 'Failed to update notification preferences' } };
  }

  return { status: 200, body: toResponseShape(row) };
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['GET', 'POST'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: true,
}, handleRequest));
