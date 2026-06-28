// API endpoint: /api/me/saved-artists-sharing
// GET  — returns the current user's sharing status.
// POST — toggles sharing on/off. Body: { public: boolean }
// Sharing requires a username (set via /settings). 404 if no username.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isReservedHandle } from '../lib/reserved-handles';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Fire-and-forget CDN cache purge by tag. Uses the same Netlify env vars as
// artist-profile.ts. No-op (with warning) if env vars aren't set (local dev/tests).
function purgeCacheTag(handle: string): void {
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteId || !token) {
    console.warn(`[user-sharing] NETLIFY_SITE_ID or NETLIFY_API_TOKEN not set, skipping CDN purge for user-share-${handle}`);
    return;
  }
  fetch('https://api.netlify.com/api/v1/purge', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_id: siteId,
      cache_tags: [`user-share-${handle}`],
    }),
  })
    .then(() => console.log(`[user-sharing] Purged CDN cache for user-share-${handle}`))
    .catch((e) => console.error(`[user-sharing] CDN cache purge failed for user-share-${handle}:`, e));
}

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email || '' };
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
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  // GET: return current sharing status
  if (event.httpMethod === 'GET') {
    try {
      const { data: usernameRow, error: usernameError } = await client
        .from('usernames')
        .select('username, saved_artists_public')
        .eq('user_id', user.userId)
        .maybeSingle();

      if (usernameError) {
        console.error('[user-sharing] Error fetching username:', usernameError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
      }

      // No username set — sharing is unavailable
      if (!usernameRow) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No username set. Set a username in Settings to enable sharing.' }) };
      }

      const isPublic = usernameRow.saved_artists_public === true;
      const handle = usernameRow.username;

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          public: isPublic,
          public_handle: isPublic ? handle : null,
          public_url: isPublic ? `https://unstream.stream/u/${handle}` : null,
        }),
      };
    } catch (error) {
      console.error('[user-sharing] GET error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // POST: toggle sharing
  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const wantPublic = body.public;
    if (typeof wantPublic !== 'boolean') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Field "public" (boolean) is required' }) };
    }

    try {
      // Fetch the user's username
      const { data: usernameRow, error: usernameError } = await client
        .from('usernames')
        .select('username, saved_artists_public')
        .eq('user_id', user.userId)
        .maybeSingle();

      if (usernameError) {
        console.error('[user-sharing] Error fetching username:', usernameError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
      }

      // No username — can't enable sharing
      if (!usernameRow) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Set a username in Settings before enabling sharing.' }) };
      }

      const handle = usernameRow.username;

      // Defense in depth: reject reserved handles even if they somehow got into the usernames table
      if (isReservedHandle(handle)) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'This username is reserved and cannot be used for sharing.' }) };
      }

      if (wantPublic) {
        // Enable sharing: set the saved_artists_public flag on usernames.
        // public.usernames is the single source of truth for handle resolution.
        const { error: flagError } = await client
          .from('usernames')
          .update({ saved_artists_public: true })
          .eq('user_id', user.userId);

        if (flagError) {
          console.error('[user-sharing] Error setting saved_artists_public:', flagError.message);
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to enable sharing' }) };
        }

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            public: true,
            public_handle: handle,
            public_url: `https://unstream.stream/u/${handle}`,
          }),
        };
      } else {
        // Disable sharing: clear the saved_artists_public flag.
        const { error: flagError } = await client
          .from('usernames')
          .update({ saved_artists_public: false })
          .eq('user_id', user.userId);

        if (flagError) {
          console.error('[user-sharing] Error clearing saved_artists_public:', flagError.message);
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to disable sharing' }) };
        }

        // Purge CDN cache for this user's shared page so it stops serving publicly.
        // Fire-and-forget — a Netlify API blip must not fail the user's disable action.
        purgeCacheTag(handle);

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            public: false,
            public_handle: null,
            public_url: null,
          }),
        };
      }
    } catch (error) {
      console.error('[user-sharing] POST error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}