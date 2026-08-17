// API endpoint: /api/me/location
// GET  — returns the current user's location string (or null).
// POST — validates and sets the user's location.
// Body: { location: string | null }
// Returns the new location on success, or a friendly error on failure.

import { getClient } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const MAX_LENGTH = 100;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  // One verification, not two: deriving the rate-limit bucket already checked the token
  // (see resolveAccountRequest), so the user it found is the user this handler uses.
  const { key, user } = await resolveAccountRequest(event.headers.authorization, ip);
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

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

  // Shared helper: ensure the caller has a usernames row before mutating it.
  // The `username` column is NOT NULL, so an upsert insert without it fails with 23502.
  // A clean UPDATE is used when the row exists; only the absence of a row triggers the
  // "set username first" error.
  async function hasUsernameRow(): Promise<boolean | { statusCode: number; headers: typeof CORS_HEADERS; body: string }> {
    const { data: existing, error } = await client
      .from('usernames')
      .select('user_id')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (error) {
      console.error('[me-location] Error checking usernames row:', error.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update location' }) };
    }

    return !!existing;
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
        const rowCheck = await hasUsernameRow();
        if (typeof rowCheck !== 'boolean') return rowCheck;
        if (!rowCheck) {
          // Location is already effectively null — desired state achieved.
          return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ location: null }) };
        }

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
      const rowCheck = await hasUsernameRow();
      if (typeof rowCheck !== 'boolean') return rowCheck;
      if (!rowCheck) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Set a username before setting your location.' }) };
      }

      const { error: updateError, count: updateCount } = await client
        .from('usernames')
        .update({ location: trimmed || null }, { count: 'exact' })
        .eq('user_id', user.userId);

      if (updateError) {
        console.error('[me-location] Error updating location:', updateError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update location' }) };
      }

      // TOCTOU: row existed at SELECT but was deleted before UPDATE. Don't
      // claim success when nothing persisted.
      if (updateCount === 0) {
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Username row missing — please set your username before changing your location.' }) };
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