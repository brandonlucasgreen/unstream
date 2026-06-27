// API endpoint: /api/me/settings
// GET — returns the current user's username (or null), email, and has_password flag.
// Used by the /settings page to populate the form on load.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

// CORS: matches the hand-rolled pattern in saved-artists.ts (permissive origin).
// The shared middleware (buildCorsHeaders) restricts to unstream.stream for
// non-API-key requests, which would break local dev and other origins using
// Bearer auth. This is existing CORS debt — see saved-artists.ts for the same pattern.
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

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

  if (event.httpMethod !== 'GET') {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  try {
    // Read username from public.usernames (PostgREST-accessible table)
    const { data: usernameRow, error: usernameError } = await client
      .from('usernames')
      .select('username')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (usernameError) {
      console.error('[me-settings] Error fetching username:', usernameError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load settings' }) };
    }

    // Read email + has_password flag via admin API (auth.users is not PostgREST-accessible)
    const { data: authData, error: authError } = await client.auth.admin.getUserById(user.userId);

    if (authError || !authData.user) {
      console.error('[me-settings] Error fetching auth user:', authError?.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load settings' }) };
    }

    const hasPassword = !!authData.user.user_metadata?.has_password;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        username: usernameRow?.username || null,
        email: authData.user.email || user.email,
        hasPassword,
      }),
    };
  } catch (error) {
    console.error('[me-settings] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}
