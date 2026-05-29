// API endpoint: /api/saved-artists
// GET  — list user's saved artists with artist details
// POST — save an artist, remove a saved artist, or bulk-check
//   Action is determined by the `action` field in the POST body:
//   action: "save" (default) — save an artist
//   action: "remove"       — remove a saved artist
//   action: "check"         — bulk check which artists are saved

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

function getServiceClient() {
  return getClient();
}

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    console.log('[saved-artists] Missing or invalid Authorization header');
    return null;
  }
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) {
    console.log(`[saved-artists] Token validation failed: ${error?.message || 'no user'}`);
    return null;
  }
  return { userId: data.user.id, email: data.user.email || '' };
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

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

  const client = getServiceClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  // GET: List user's saved artists (auth required)
  if (event.httpMethod === 'GET') {
    const user = await authenticateRequest(event.headers.authorization);
    if (!user) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    try {
      const { data: saved, error: savedError } = await client
        .from('saved_artists')
        .select(`
          id,
          user_id,
          artist_id,
          notes,
          added_at,
          artists!inner (
            id,
            name,
            slug,
            image_url
          )
        `)
        .eq('user_id', user.userId);

      if (savedError) {
        console.error('[saved-artists] Error fetching saved artists:', savedError);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch saved artists' }) };
      }

      const savedArtists = (saved || []).map(row => ({
        artistId: row.artist_id,
        name: (row as any).artists?.name || 'Unknown',
        slug: (row as any).artists?.slug || '',
        imageUrl: (row as any).artists?.image_url || null,
        notes: row.notes,
        addedAt: row.added_at,
      }));

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ savedArtists }),
      };
    } catch (error) {
      console.error('[saved-artists] GET error:', error);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // POST: Route by action field
  if (event.httpMethod === 'POST') {
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

    const action = (body.action as string) || 'save';

    if (action === 'check') {
      return handleCheck(user, body, client);
    }
    if (action === 'remove') {
      return handleRemove(user, body, client);
    }
    return handleSave(user, body, client);
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}

// Validate that a string is a UUID
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

async function handleSave(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getClient> & { from: (table: string) => any }) {
  const artistId = body.artistId as string;
  if (!artistId || !isValidUUID(artistId)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid artistId (UUID) is required' }) };
  }

  try {
    // Verify artist exists
    const { data: artist } = await client
      .from('artists')
      .select('id, name, slug, image_url')
      .eq('id', artistId)
      .single();

    if (!artist) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist not found' }) };
    }

    // Upsert — idempotent if already saved
    const { data: saved, error: upsertError } = await client
      .from('saved_artists')
      .upsert({
        user_id: user.userId,
        artist_id: artistId,
        notes: (body.notes as string) || null,
      }, { onConflict: 'user_id,artist_id' })
      .select()
      .single();

    if (upsertError) {
      console.error('[saved-artists] Error saving artist:', upsertError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to save artist' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        savedArtist: {
          artistId: saved.artist_id,
          name: artist.name,
          slug: artist.slug,
          imageUrl: artist.image_url || null,
          notes: saved.notes,
          addedAt: saved.added_at,
        },
      }),
    };
  } catch (error) {
    console.error('[saved-artists] Save error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}

async function handleRemove(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getClient> & { from: (table: string) => any }) {
  const artistId = body.artistId as string;
  if (!artistId || !isValidUUID(artistId)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid artistId (UUID) is required' }) };
  }

  try {
    const { error: deleteError } = await client
      .from('saved_artists')
      .delete()
      .eq('user_id', user.userId)
      .eq('artist_id', artistId);

    if (deleteError) {
      console.error('[saved-artists] Error removing saved artist:', deleteError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to remove saved artist' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error('[saved-artists] Remove error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}

async function handleCheck(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getClient> & { from: (table: string) => any }) {
  const artistIds = body.artistIds as string[];
  if (!artistIds || !Array.isArray(artistIds)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistIds array is required' }) };
  }

  // Cap at 100 IDs
  if (artistIds.length > 100) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Maximum 100 artist IDs allowed' }) };
  }

  // Validate all are UUIDs
  if (artistIds.some(id => typeof id !== 'string' || !isValidUUID(id))) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'All artistIds must be valid UUIDs' }) };
  }

  try {
    const { data: saved, error: checkError } = await client
      .from('saved_artists')
      .select('artist_id')
      .eq('user_id', user.userId)
      .in('artist_id', artistIds);

    if (checkError) {
      console.error('[saved-artists] Error checking saved artists:', checkError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to check saved artists' }) };
    }

    const savedArtistIds = (saved || []).map((row: { artist_id: string }) => row.artist_id);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ savedArtistIds }),
    };
  } catch (error) {
    console.error('[saved-artists] Check error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}
