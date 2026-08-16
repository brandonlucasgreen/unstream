// API endpoint: /api/me/notification-preferences
// GET  — returns the current user's toggles for saved-artist and analytics-recap emails.
// POST — updates one or more toggles. Body: { newRelease?, newPlatformLink?, weeklyAnalyticsRecap? }
//
// A user who has never touched these has no row in notification_preferences at all — GET
// reports that as all-true (the default) without creating one, and POST upserts a row only
// once they actually change something. Every sender (notifications.ts,
// weekly-analytics-recap.ts) treats a missing row the same way.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

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
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  if (event.httpMethod === 'GET') {
    const { data: row, error } = await client
      .from('notification_preferences')
      .select('new_release, new_platform_link, weekly_analytics_recap')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (error) {
      console.error('[me-notifications] Error fetching preferences:', error.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load notification preferences' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(toResponseShape(row)) };
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const patch: Partial<PreferencesRow> = {};
    if ('newRelease' in body) {
      if (typeof body.newRelease !== 'boolean') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'newRelease must be a boolean' }) };
      }
      patch.new_release = body.newRelease;
    }
    if ('newPlatformLink' in body) {
      if (typeof body.newPlatformLink !== 'boolean') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'newPlatformLink must be a boolean' }) };
      }
      patch.new_platform_link = body.newPlatformLink;
    }
    if ('weeklyAnalyticsRecap' in body) {
      if (typeof body.weeklyAnalyticsRecap !== 'boolean') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'weeklyAnalyticsRecap must be a boolean' }) };
      }
      patch.weekly_analytics_recap = body.weeklyAnalyticsRecap;
    }

    if (Object.keys(patch).length === 0) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No recognized preference fields in body' }) };
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
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update notification preferences' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(toResponseShape(row)) };
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}
