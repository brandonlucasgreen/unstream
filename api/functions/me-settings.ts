// API endpoint: /api/me/settings
// GET — returns the current user's username (or null), email, and has_password flag.
// Used by the /settings page to populate the form on load.

import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from './ratelimit';

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

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  const serviceClient = createClient(url, serviceKey);

  try {
    const { data, error } = await serviceClient
      .from('auth.users')
      .select('username, email')
      .eq('id', user.userId)
      .single();

    if (error || !data) {
      console.error('[me-settings] Error fetching user data:', error?.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load settings' }) };
    }

    // Determine if the user has a password set.
    // We check user_metadata.has_password which is set when a password is created or updated.
    // Users who signed up via magic link only won't have this flag.
    const { data: authData } = await serviceClient.auth.admin.getUserById(user.userId);
    const hasPassword = !!authData?.user?.user_metadata?.has_password;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        username: data.username || null,
        email: data.email,
        hasPassword,
      }),
    };
  } catch (error) {
    console.error('[me-settings] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}