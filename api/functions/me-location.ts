// API endpoint: /api/me/location
// GET  — returns the current user's location string (or null).
// POST — validates and sets the user's location.
// Body: { location: string | null }
// Returns the new location on success, or a friendly error on failure.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

const MAX_LENGTH = 100;

async function handleRequest({ method, user, body }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  if (method === 'GET') {
    try {
      const { data: row, error } = await client
        .from('usernames')
        .select('location')
        .eq('user_id', user.userId)
        .maybeSingle();

      if (error) {
        console.error('[me-location] Error fetching location:', error.message);
        return { status: 500, body: { error: 'Failed to load location' } };
      }

      return { status: 200, body: { location: row?.location ?? null } };
    } catch (error) {
      console.error('[me-location] GET error:', error);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  }

  // POST from here on: the wrapper has already refused every other method.

  // Shared helper: ensure the caller has a usernames row before mutating it.
  // The `username` column is NOT NULL, so an upsert insert without it fails with 23502.
  // A clean UPDATE is used when the row exists; only the absence of a row triggers the
  // "set username first" error.
  async function hasUsernameRow(): Promise<boolean | EndpointResult> {
    // Captured locally: the guard above narrowed `client`, but a closure doesn't inherit that
    // narrowing — TypeScript has to assume something reassigned it in between.
    const db = client!;
    const { data: existing, error } = await db
      .from('usernames')
      .select('user_id')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (error) {
      console.error('[me-location] Error checking usernames row:', error.message);
      return { status: 500, body: { error: 'Failed to update location' } };
    }

    return !!existing;
  }

  const raw = body.location;
  // Allow null to clear the field
  if (raw === null) {
    try {
      const rowCheck = await hasUsernameRow();
      if (typeof rowCheck !== 'boolean') return rowCheck;
      if (!rowCheck) {
        // Location is already effectively null — desired state achieved.
        return { status: 200, body: { location: null } };
      }

      const { error: updateError } = await client
        .from('usernames')
        .update({ location: null })
        .eq('user_id', user.userId);

      if (updateError) {
        console.error('[me-location] Error clearing location:', updateError.message);
        return { status: 500, body: { error: 'Failed to update location' } };
      }

      return { status: 200, body: { location: null } };
    } catch (error) {
      console.error('[me-location] POST (null) error:', error);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  }

  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (trimmed.length > MAX_LENGTH) {
    return { status: 400, body: { error: `Location must be ${MAX_LENGTH} characters or fewer.` } };
  }

  try {
    const rowCheck = await hasUsernameRow();
    if (typeof rowCheck !== 'boolean') return rowCheck;
    if (!rowCheck) {
      return { status: 400, body: { error: 'Set a username before setting your location.' } };
    }

    const { error: updateError, count: updateCount } = await client
      .from('usernames')
      .update({ location: trimmed || null }, { count: 'exact' })
      .eq('user_id', user.userId);

    if (updateError) {
      console.error('[me-location] Error updating location:', updateError.message);
      return { status: 500, body: { error: 'Failed to update location' } };
    }

    // TOCTOU: row existed at SELECT but was deleted before UPDATE. Don't
    // claim success when nothing persisted.
    if (updateCount === 0) {
      return { status: 409, body: { error: 'Username row missing — please set your username before changing your location.' } };
    }

    return { status: 200, body: { location: trimmed || null } };
  } catch (error) {
    console.error('[me-location] POST error:', error);
    return { status: 500, body: { error: 'Internal server error' } };
  }
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['GET', 'POST'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: true,
}, handleRequest));
