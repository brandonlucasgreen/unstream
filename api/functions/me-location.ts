// API endpoint: /api/me/location
// GET  — returns the current user's location string (or null).
// POST — validates and sets the user's location.
// Body: { location: string | null }
// Returns the new location on success, or a friendly error on failure.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const MAX_LENGTH = 100;

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

  if (event.httpMethod === 'GET') {
    try {
      const { data: row, error } = await client
        .from('usernames')
        .select('location')
        .eq('user_id', user.userId)
        .maybeSingle();

      if (error) {
        console.error('[me-location] Error fetching location:', error.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load location' }) };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ location: row?.location ?? null }),
      };
    } catch (error) {
      console.error('[me-location] GET error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const raw = body.location;
    // Allow null to clear the field
    if (raw === null) {
      try {
        const { error: updateError } = await client
          .from('usernames')
          .update({ location: null })
          .eq('user_id', user.userId);

        if (updateError) {
          console.error('[me-location] Error clearing location:', updateError.message);
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update location' }) };
        }

        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ location: null }) };
      } catch (error) {
        console.error('[me-location] POST (null) error:', error);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
      }
    }

    const trimmed = typeof raw === 'string' ? raw.trim() : '';

    if (trimmed.length > MAX_LENGTH) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Location must be ${MAX_LENGTH} characters or fewer.` }) };
    }

    try {
      const { error: updateError } = await client
        .from('usernames')
        .update({ location: trimmed || null })
        .eq('user_id', user.userId);

      if (updateError) {
        console.error('[me-location] Error updating location:', updateError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update location' }) };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ location: trimmed || null }),
      };
    } catch (error) {
      console.error('[me-location] POST error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}