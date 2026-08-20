// API endpoint: /api/public/saved-artists/:handle
// GET — public, anonymous-accessible. Returns a user's saved artists list and public
// collection if sharing is enabled. 404 on private, unknown handle, or missing username.
// Rate limited at 'standard' tier (30/min/IP) per amendment 1.
//
// The collection and the saved list are two views of the same relationship — artists you
// support, and the releases you bought to support them (Support Loop Step 3). Only
// provenance='purchased', non-hidden items are ever public: a page that counted anything
// else as support would be lying, and the whole value of the artifact is that it isn't.

import { getClient, readAllPages } from './db';
import { artistUrlFor, collectionArtUrl, releaseUrlFor, resolveArtistPages } from './collection-utils';
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

    // Public collection: purchased and not hidden, most recently acquired first. Paged read
    // because a real Bandcamp collection can exceed PostgREST's silent 1,000-row cap.
    const collectionRead = await readAllPages<{
      id: string;
      title: string;
      artist_name: string;
      art_url: string | null;
      acquired_at: string | null;
      releases: { slug: string; artwork_url: string | null; artists: { slug: string } | null } | null;
    }>(
      (from, to) =>
        client
          .from('collection_items')
          .select('id, title, artist_name, art_url, acquired_at, releases!left (slug, artwork_url, artists (slug))')
          .eq('user_id', userId)
          .eq('provenance', 'purchased')
          .eq('hidden', false)
          .order('acquired_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .range(from, to),
      'collection_items (public page)'
    );

    if (!collectionRead.ok) {
      console.error('[public-saved-artists] Error fetching collection:', collectionRead.reason);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
    }

    const artistPages = await resolveArtistPages(collectionRead.rows.map(r => r.artist_name));

    const collection = collectionRead.rows.map(row => ({
      id: row.id,
      title: row.title,
      artist_name: row.artist_name,
      // Falls back to the art proxy, which fetches from Bandcamp server-side. Only ~28% of a
      // real collection matches an Unstream release, so without this most tiles are blank.
      // Tokened: this endpoint has already applied the public-page rules (sharing on,
      // purchased, not hidden), so the proxy can trust the URL instead of re-checking them.
      art_url: row.art_url || row.releases?.artwork_url || collectionArtUrl(row.id),
      acquired_at: row.acquired_at,
      // Matched items link to the release page, so a viewer can buy the same record —
      // the loop closes. Unmatched items still render, just without a link.
      url: releaseUrlFor(row),
      artist_url: artistUrlFor(row, artistPages),
    }));

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
        collection,
      }),
    };
  } catch (error) {
    console.error('[public-saved-artists] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}