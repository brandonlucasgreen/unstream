// API endpoint: /api/me/username
// POST — validates and sets the user's username.
// Body: { username: string }
// Returns the new username on success, or a friendly error on failure.

import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

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

  if (event.httpMethod !== 'POST') {
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

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const username = (body.username as string | undefined)?.trim();

  if (!username) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Username is required' }) };
  }

  if (!USERNAME_REGEX.test(username)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Username must be 3-20 characters, lowercase letters, numbers, and hyphens. No leading or trailing hyphens.' }),
    };
  }

  const serviceClient = createClient(url, serviceKey);

  try {
    // Check if the user already has this username (no-op case)
    const { data: existing } = await serviceClient
      .from('auth.users')
      .select('username')
      .eq('id', user.userId)
      .single();

    if (existing?.username === username) {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ username }) };
    }

    // Check for collision before attempting the update
    const { data: conflict } = await serviceClient
      .from('auth.users')
      .select('id')
      .eq('username', username)
      .neq('id', user.userId)
      .maybeSingle();

    if (conflict) {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Username is already taken' }) };
    }

    const { error: updateError } = await serviceClient
      .from('auth.users')
      .update({ username })
      .eq('id', user.userId);

    if (updateError) {
      // Handle unique constraint violation as a friendly duplicate error
      if (updateError.code === '23505') {
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Username is already taken' }) };
      }
      console.error('[me-username] Error updating username:', updateError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update username' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ username }) };
  } catch (error) {
    console.error('[me-username] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}