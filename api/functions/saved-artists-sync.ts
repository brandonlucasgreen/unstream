// API endpoint: /api/saved-artists/sync
// GET — incremental or full sync of user's saved artists
// Returns artists modified since a given timestamp (cursor), or all if no since param.
// Designed for cross-client sync: the client stores the server_time from the last
// successful pull and passes it as `since` on the next request.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

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

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const SYNC_LIMIT = 500;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
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

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  const since = event.queryStringParameters?.since;

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
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid since parameter: must be ISO-8601' }) };
    }
    // Use > not >= for cursor safety — a client passing server_time from last pull
    // should not re-receive rows modified at exactly that instant
    query = query.gt('last_modified', sinceDate.toISOString());
  }

  try {
    const { data: saved, error: savedError } = await query;

    if (savedError) {
      console.error('[saved-artists-sync] Error fetching:', savedError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch saved artists' }) };
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

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ artists, server_time: serverTime }),
    };
  } catch (error) {
    console.error('[saved-artists-sync] GET error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}