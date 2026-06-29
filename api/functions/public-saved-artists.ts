// API endpoint: /api/public/saved-artists/:handle
// GET — public, anonymous-accessible. Returns a user's saved artists list if sharing is enabled.
// 404 on private, unknown handle, or missing username.
// Rate limited at 'standard' tier (30/min/IP) per amendment 1.

import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  path?: string;
  pathParameters?: Record<string, string | undefined>;
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

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  // Extract handle from path parameters or path
  const handle = event.pathParameters?.handle || event.path?.split('/').pop()?.replace(/\/$/, '');

  if (!handle) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Handle is required' }) };
  }

  try {
    // Look up the username row to get user_id + check sharing flag + location
    const { data: usernameRow, error: usernameError } = await client
      .from('usernames')
      .select('user_id, username, saved_artists_public, location')
      .eq('username', handle)
      .maybeSingle();

    if (usernameError) {
      console.error('[public-saved-artists] Error fetching username:', usernameError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }

    // Unknown handle or no username — 404 (not 403, to avoid leaking existence)
    if (!usernameRow) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    }

    // Sharing is disabled — 404 (not 403, to avoid leaking existence)
    if (!usernameRow.saved_artists_public) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    }

    const userId = usernameRow.user_id;
    const ownerDisplayName = usernameRow.username;
    const ownerLocation = usernameRow.location ?? null;

    // Fetch saved artists for this user (non-deleted only)
    const { data: saved, error: savedError } = await client
      .from('saved_artists')
      .select(`
        artist_slug,
        artist_name,
        artist_image_url,
        supported,
        artists!left (slug, name, image_url)
      `)
      .eq('user_id', userId)
      .eq('deleted', false);

    if (savedError) {
      console.error('[public-saved-artists] Error fetching saved artists:', savedError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }

    // Shape the response — NEVER include email, user_id, or account metadata
    const savedArtists = (saved || []).map((row: any) => {
      const artistRow = row.artists;
      return {
        slug: artistRow?.slug || row.artist_slug || '',
        name: artistRow?.name || row.artist_name || 'Unknown',
        image_url: artistRow?.image_url || row.artist_image_url || null,
        supported: row.supported === true,
      };
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        owner_display_name: ownerDisplayName,
        owner_location: ownerLocation,
        saved_artists: savedArtists,
      }),
    };
  } catch (error) {
    console.error('[public-saved-artists] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}