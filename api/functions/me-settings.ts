// API endpoint: /api/me/settings
// GET — returns the current user's username (or null), email, and has_password flag.
// Used by the /settings page to populate the form on load.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, accountRateLimitKey, getClientIp } from './ratelimit';

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

// getUser(token) validates the token against the auth server and returns the
// user's *current* record (not the stale token claims), so email and
// user_metadata here are as fresh as a separate admin.getUserById lookup.
//
// This is the one account endpoint that still pays for that round trip. The others take
// their user from resolveAccountRequest, which verifies the JWT locally — but local
// verification surfaces only `sub` and `email`, and this endpoint needs
// `user_metadata.has_password`. Reading that from token claims would be a guess about what
// Supabase puts in an access token, and getting it wrong shows somebody who has a password
// the "your account was created with a magic link" branch of /settings. So it stays.
//
// The cost is smaller here than it looks: the call below is started *before* the rate-limit
// check and awaited after, so the round trip overlaps Redis rather than following it.
async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string; hasPassword: boolean } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return {
    userId: data.user.id,
    email: data.user.email || '',
    hasPassword: !!data.user.user_metadata?.has_password,
  };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Rate-limit check (Redis) and token validation (Supabase Auth) are both
  // network round-trips with no data dependency — run them concurrently. Deriving
  // the rate-limit key first costs nothing to that: it verifies the JWT locally.
  const ip = getClientIp(event.headers);
  const rlKey = await accountRateLimitKey(event.headers.authorization, ip);
  const rlPromise = checkRateLimit(rlKey, 'account', CORS_HEADERS);
  const userPromise = authenticateRequest(event.headers.authorization).catch(() => null);
  const rl = await rlPromise;
  if (rl.limited) return rl.response;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await userPromise;
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  try {
    // Read username + location from public.usernames (PostgREST-accessible table).
    // Email and has_password already came back with the token validation above.
    const { data: usernameRow, error: usernameError } = await client
      .from('usernames')
      .select('username, location')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (usernameError) {
      console.error('[me-settings] Error fetching username:', usernameError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load settings' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        username: usernameRow?.username || null,
        location: usernameRow?.location ?? null,
        email: user.email,
        hasPassword: user.hasPassword,
      }),
    };
  } catch (error) {
    console.error('[me-settings] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}
