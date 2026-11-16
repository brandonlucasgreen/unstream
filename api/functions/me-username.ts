// API endpoint: /api/me/username
// POST — validates and sets the user's username.
// Body: { username: string }
// Returns the new username on success, or a friendly error on failure.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { isReservedHandle } from '../lib/reserved-handles';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

async function handleRequest({ user, body }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  const username = (body.username as string | undefined)?.trim();

  if (!username) {
    return { status: 400, body: { error: 'Username is required' } };
  }

  if (!USERNAME_REGEX.test(username)) {
    return {
      status: 400,
      body: { error: 'Username must be 3-20 characters, lowercase letters, numbers, and hyphens. No leading or trailing hyphens.' },
    };
  }

  if (isReservedHandle(username)) {
    return { status: 400, body: { error: 'This username is reserved' } };
  }

  try {
    // Check if the user already has this username (no-op case)
    const { data: existing } = await client
      .from('usernames')
      .select('username')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (existing?.username === username) {
      return { status: 200, body: { username } };
    }

    // Check for collision before attempting the upsert
    const { data: conflict } = await client
      .from('usernames')
      .select('user_id')
      .eq('username', username)
      .neq('user_id', user.userId)
      .maybeSingle();

    if (conflict) {
      return { status: 409, body: { error: 'Username is already taken' } };
    }

    // Upsert: insert or update the user's username row
    const { error: upsertError } = await client
      .from('usernames')
      .upsert(
        { user_id: user.userId, username, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      if (upsertError.code === '23505') {
        return { status: 409, body: { error: 'Username is already taken' } };
      }
      console.error('[me-username] Error updating username:', upsertError.message);
      return { status: 500, body: { error: 'Failed to update username' } };
    }

    return { status: 200, body: { username } };
  } catch (error) {
    console.error('[me-username] Error:', error);
    return { status: 500, body: { error: 'Internal server error' } };
  }
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['POST'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: true,
}, handleRequest));
