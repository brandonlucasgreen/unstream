// API endpoint: /api/saved-artists/sync
// GET — incremental or full sync of user's saved artists
// Returns artists modified since a given timestamp (cursor), or all if no since param.
// Designed for cross-client sync: the client stores the server_time from the last
// successful pull and passes it as `since` on the next request.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

const SYNC_LIMIT = 500;

async function handleRequest({ user, query: params }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  const since = params.since;

  let query = client
    .from('saved_artists')
    .select(`
      id,
      user_id,
      artist_id,
      artist_slug,
      artist_name,
      artist_image_url,
      notes,
      added_at,
      supported,
      supported_at,
      last_modified,
      device_id,
      deleted,
      deleted_at,
      artists!left (id, name, slug, image_url)
    `)
    .eq('user_id', user.userId)
    .order('last_modified', { ascending: true })
    .limit(SYNC_LIMIT);

  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return { status: 400, body: { error: 'Invalid since parameter: must be ISO-8601' } };
    }
    // Use > not >= for cursor safety — a client passing server_time from last pull
    // should not re-receive rows modified at exactly that instant
    query = query.gt('last_modified', sinceDate.toISOString());
  }

  try {
    const { data: saved, error: savedError } = await query;

    if (savedError) {
      console.error('[saved-artists-sync] Error fetching:', savedError);
      return { status: 500, body: { error: 'Failed to fetch saved artists' } };
    }

    const artists = (saved || []).map(row => {
      const artistRow = (row as any).artists;
      const claimed = !!artistRow;
      return {
        id: row.id,
        userId: row.user_id,
        artistId: artistRow?.slug || row.artist_slug || row.artist_id,
        name: artistRow?.name || row.artist_name || 'Unknown',
        slug: artistRow?.slug || row.artist_slug || '',
        imageUrl: artistRow?.image_url || row.artist_image_url || null,
        notes: row.notes,
        addedAt: row.added_at,
        supported: row.supported,
        supportedAt: row.supported_at,
        lastModified: row.last_modified,
        deviceId: row.device_id,
        claimed,
        deleted: row.deleted ?? false,
      };
    });

    const serverTime = new Date().toISOString();

    return { status: 200, body: { artists, server_time: serverTime } };
  } catch (error) {
    console.error('[saved-artists-sync] GET error:', error);
    return { status: 500, body: { error: 'Internal server error' } };
  }
}

export const handler = withSentry(endpoint({
  // The extension's popup syncs from here, from its own origin, so that is allowed too
  // (account-cors.ts says why).
  cors: 'accountAndExtension',
  methods: ['GET'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: false,
}, handleRequest));
