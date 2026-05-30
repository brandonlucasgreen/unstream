// API endpoint: /api/saved-artists
// GET  — list user's saved artists with artist details
// POST — save an artist, remove a saved artist, bulk-check, or toggle supported
//   Action is determined by the `action` field in the POST body:
//   action: "save"      (default) — save an artist
//   action: "remove"              — remove a saved artist
//   action: "check"               — bulk check which artists are saved
//   action: "support"             — mark a saved artist as supported
//   action: "unsupport"           — unmark a saved artist as supported
//
// Saving an artist does NOT create a row in the `artists` table.
// Unclaimed artists don't get /a/ profile pages — only claimed ones do.
// We store the search result data (slug, name, imageUrl) directly in saved_artists.

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
          artist_slug,
          artist_name,
          artist_image_url,
          notes,
          added_at,
          supported,
          supported_at,
          artists!left (id, name, slug, image_url)
        `)
        .eq('user_id', user.userId);

      if (savedError) {
        console.error('[saved-artists] Error fetching saved artists:', savedError);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch saved artists' }) };
      }

      const savedArtists = (saved || []).map(row => {
        // Prefer data from the artists table (claimed/verified artists) when available
        const artistRow = (row as any).artists;
        const claimed = !!artistRow;
        return {
          artistId: artistRow?.slug || row.artist_slug || row.artist_id,
          name: artistRow?.name || row.artist_name || 'Unknown',
          slug: artistRow?.slug || row.artist_slug || '',
          imageUrl: artistRow?.image_url || row.artist_image_url || null,
          notes: row.notes,
          addedAt: row.added_at,
          supported: row.supported,
          supportedAt: row.supported_at,
          claimed,
        };
      });

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
    if (action === 'support') {
      return handleSupport(user, body, client);
    }
    if (action === 'unsupport') {
      return handleUnsupport(user, body, client);
    }
    return handleSave(user, body, client);
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}

// Resolve a slug to an existing artists table row (no creation).
// Only claimed/verified artists will have rows.
async function findExistingArtist(
  client: ReturnType<typeof getServiceClient>,
  slug: string,
): Promise<{ id: string; name: string; slug: string; image_url: string | null } | null> {
  // Exact slug match first
  const { data: exact } = await client
    .from('artists')
    .select('id, name, slug, image_url')
    .eq('slug', slug)
    .single();
  if (exact) return exact;

  // Case-insensitive fallback
  const { data: ciData } = await client
    .from('artists')
    .select('id, name, slug, image_url')
    .ilike('slug', slug)
    .single();
  return ciData;
}

async function handleSave(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getServiceClient>) {
  const artistSlug = (body.artistId as string) || (body.slug as string);
  const artistName = body.name as string | undefined;
  const artistImageUrl = body.imageUrl as string | undefined;

  if (!artistSlug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistId (slug) is required' }) };
  }

  try {
    // Check if this artist already has a row in the artists table (claimed/verified)
    const existingArtist = await findExistingArtist(client, artistSlug);
    const artistId = existingArtist?.id || null;
    const name = existingArtist?.name || artistName || artistSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const imageUrl = existingArtist?.image_url || artistImageUrl || null;
    const slug = existingArtist?.slug || artistSlug;

    // Upsert — idempotent if already saved
    const { data: saved, error: upsertError } = await client
      .from('saved_artists')
      .upsert({
        user_id: user.userId,
        artist_id: artistId,
        artist_slug: slug,
        artist_name: name,
        artist_image_url: imageUrl,
        notes: (body.notes as string) || null,
      }, { onConflict: 'user_id,artist_slug' })
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
          artistId: slug,
          name,
          slug,
          imageUrl,
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

async function handleRemove(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getServiceClient>) {
  const artistSlug = (body.artistId as string) || (body.slug as string);
  if (!artistSlug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistId is required' }) };
  }

  try {
    const { error: deleteError } = await client
      .from('saved_artists')
      .delete()
      .eq('user_id', user.userId)
      .eq('artist_slug', artistSlug);

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

async function handleCheck(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getServiceClient>) {
  const artistSlugs = body.artistIds as string[];
  if (!artistSlugs || !Array.isArray(artistSlugs)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistIds array is required' }) };
  }

  // Cap at 100 IDs
  if (artistSlugs.length > 100) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Maximum 100 artist IDs allowed' }) };
  }

  try {
    // Look up saved artists by slug (the identifier the frontend uses)
    const { data: saved, error: checkError } = await client
      .from('saved_artists')
      .select('artist_slug')
      .eq('user_id', user.userId)
      .in('artist_slug', artistSlugs);

    if (checkError) {
      console.error('[saved-artists] Error checking saved artists:', checkError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to check saved artists' }) };
    }

    const savedArtistIds = (saved || []).map((row: any) => row.artist_slug);

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

async function handleSupport(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getServiceClient>) {
  const artistSlug = (body.artistId as string) || (body.slug as string);
  if (!artistSlug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistId is required' }) };
  }

  try {
    // Idempotent: set supported=true even if already true
    const { data: updated, error: updateError } = await client
      .from('saved_artists')
      .update({ supported: true, supported_at: new Date().toISOString() })
      .eq('user_id', user.userId)
      .eq('artist_slug', artistSlug)
      .select(`
        id, user_id, artist_id, artist_slug, artist_name, artist_image_url,
        notes, added_at, supported, supported_at,
        artists!left (id, name, slug, image_url)
      `)
      .single();

    if (updateError) {
      console.error('[saved-artists] Error supporting artist:', updateError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to support artist' }) };
    }

    if (!updated) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Saved artist not found' }) };
    }

    const artistRow = (updated as any).artists;
    const claimed = !!artistRow;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        savedArtist: {
          artistId: artistRow?.slug || updated.artist_slug || updated.artist_id,
          name: artistRow?.name || updated.artist_name || 'Unknown',
          slug: artistRow?.slug || updated.artist_slug || '',
          imageUrl: artistRow?.image_url || updated.artist_image_url || null,
          notes: updated.notes,
          addedAt: updated.added_at,
          supported: updated.supported,
          supportedAt: updated.supported_at,
          claimed,
        },
      }),
    };
  } catch (error) {
    console.error('[saved-artists] Support error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}

async function handleUnsupport(user: { userId: string; email: string }, body: Record<string, unknown>, client: ReturnType<typeof getServiceClient>) {
  const artistSlug = (body.artistId as string) || (body.slug as string);
  if (!artistSlug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artistId is required' }) };
  }

  try {
    // Idempotent: set supported=false even if already false
    const { data: updated, error: updateError } = await client
      .from('saved_artists')
      .update({ supported: false, supported_at: null })
      .eq('user_id', user.userId)
      .eq('artist_slug', artistSlug)
      .select(`
        id, user_id, artist_id, artist_slug, artist_name, artist_image_url,
        notes, added_at, supported, supported_at,
        artists!left (id, name, slug, image_url)
      `)
      .single();

    if (updateError) {
      console.error('[saved-artists] Error unsupporting artist:', updateError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to unsupport artist' }) };
    }

    if (!updated) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Saved artist not found' }) };
    }

    const artistRow = (updated as any).artists;
    const claimed = !!artistRow;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        savedArtist: {
          artistId: artistRow?.slug || updated.artist_slug || updated.artist_id,
          name: artistRow?.name || updated.artist_name || 'Unknown',
          slug: artistRow?.slug || updated.artist_slug || '',
          imageUrl: artistRow?.image_url || updated.artist_image_url || null,
          notes: updated.notes,
          addedAt: updated.added_at,
          supported: updated.supported,
          supportedAt: updated.supported_at,
          claimed,
        },
      }),
    };
  } catch (error) {
    console.error('[saved-artists] Unsupport error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}