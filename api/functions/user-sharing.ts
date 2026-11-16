// API endpoint: /api/me/saved-artists-sharing
// GET  — returns the current user's sharing status.
// POST — toggles sharing on/off. Body: { public: boolean }
// Sharing requires a username (set via /settings). 404 if no username.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { isReservedHandle } from '../lib/reserved-handles';
import { purgeCacheTags } from './purge-cache';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

async function handleRequest({ method, user, body }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  // GET: return current sharing status
  if (method === 'GET') {
    try {
      const { data: usernameRow, error: usernameError } = await client
        .from('usernames')
        .select('username, saved_artists_public')
        .eq('user_id', user.userId)
        .maybeSingle();

      if (usernameError) {
        console.error('[user-sharing] Error fetching username:', usernameError.message);
        return { status: 500, body: { error: 'Internal server error' } };
      }

      // No username set — sharing is unavailable
      if (!usernameRow) {
        return { status: 404, body: { error: 'No username set. Set a username in Settings to enable sharing.' } };
      }

      const isPublic = usernameRow.saved_artists_public === true;
      const handle = usernameRow.username;

      return {
        status: 200,
        body: {
          public: isPublic,
          public_handle: isPublic ? handle : null,
          public_url: isPublic ? `https://unstream.stream/u/${handle}` : null,
        },
      };
    } catch (error) {
      console.error('[user-sharing] GET error:', error);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  }

  // POST: toggle sharing. The wrapper has already refused every other method.
  const wantPublic = body.public;
  if (typeof wantPublic !== 'boolean') {
    return { status: 400, body: { error: 'Field "public" (boolean) is required' } };
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
      return { status: 500, body: { error: 'Internal server error' } };
    }

    // No username — can't enable sharing
    if (!usernameRow) {
      return { status: 400, body: { error: 'Set a username in Settings before enabling sharing.' } };
    }

    const handle = usernameRow.username;

    // Defense in depth: reject reserved handles even if they somehow got into the usernames table
    if (isReservedHandle(handle)) {
      return { status: 400, body: { error: 'This username is reserved and cannot be used for sharing.' } };
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
        return { status: 500, body: { error: 'Failed to enable sharing' } };
      }

      return {
        status: 200,
        body: {
          public: true,
          public_handle: handle,
          public_url: `https://unstream.stream/u/${handle}`,
        },
      };
    } else {
      // Disable sharing: clear the saved_artists_public flag.
      const { error: flagError } = await client
        .from('usernames')
        .update({ saved_artists_public: false })
        .eq('user_id', user.userId);

      if (flagError) {
        console.error('[user-sharing] Error clearing saved_artists_public:', flagError.message);
        return { status: 500, body: { error: 'Failed to disable sharing' } };
      }

      // Purge CDN cache for this user's shared page so it stops serving publicly.
      //
      // Awaited, not fire-and-forget: Lambda freezes once the handler returns, so an un-awaited
      // purge could simply never be sent, and the list someone just made private would keep
      // serving publicly from the CDN for its TTL. purgeCacheTags never throws, so a Netlify API
      // blip still can't fail the disable itself.
      await purgeCacheTags([`user-share-${handle}`], 'user-sharing');

      return {
        status: 200,
        body: {
          public: false,
          public_handle: null,
          public_url: null,
        },
      };
    }
  } catch (error) {
    console.error('[user-sharing] POST error:', error);
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
