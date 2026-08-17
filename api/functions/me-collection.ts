// API endpoint: /api/me/collection
// GET  — the signed-in user's collection items (including hidden ones — this is the
//        owner's view; the public page filters to provenance='purchased' AND NOT hidden).
// POST — { id, hidden }: hide or unhide one of the user's own items on the public page.
//
// Support Loop Step 1 (support-loop-spec.md); the collection page rebuild (Step 3) renders
// from this. Writes to collection_items happen only in sync code (bandcamp-sync-background)
// — this endpoint can flip `hidden` and nothing else, so provenance stays server-asserted.

import { getClient, readAllPages } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';
import {
  artistUrlFor,
  releaseUrlFor,
  resolveArtistPages,
  type CollectionRowWithRelease,
} from './collection-utils';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const ITEM_COLUMNS =
  'id, source, title, artist_name, art_url, acquired_at, provenance, acquisition, hidden, release_id';

/** The same columns plus the joins the grid needs to build release and artist links. */
const ITEM_COLUMNS_WITH_LINKS = `${ITEM_COLUMNS}, releases!left (slug, artwork_url, artists (slug))`;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // One verification, not two: deriving the rate-limit bucket already checked the token
  // (see resolveAccountRequest), so the user it found is the user this handler uses.
  const ip = getClientIp(event.headers);
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
    // Paged read: a real Bandcamp collection can exceed PostgREST's silent 1,000-row cap.
    const read = await readAllPages<Record<string, unknown> & CollectionRowWithRelease & { id: string }>(
      (from, to) =>
        client
          .from('collection_items')
          .select(ITEM_COLUMNS_WITH_LINKS)
          .eq('user_id', user.userId)
          .order('acquired_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .range(from, to),
      'collection_items'
    );

    if (!read.ok) {
      console.error('[me-collection] Error fetching items:', read.reason);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load collection' }) };
    }

    const artistPages = await resolveArtistPages(read.rows.map(r => r.artist_name));

    const items = read.rows.map(({ releases, ...row }) => ({
      ...row,
      // Same art fallback as the public page: unmatched items get their cover from Bandcamp
      // via the proxy rather than rendering an empty box.
      art_url: row.art_url || releases?.artwork_url || `/api/collection/art/${row.id}`,
      url: releaseUrlFor({ ...row, releases }),
      artist_url: artistUrlFor({ ...row, releases }, artistPages),
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ items, total: items.length }),
    };
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'id is required' }) };
    }
    if (typeof body.hidden !== 'boolean') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'hidden must be a boolean' }) };
    }

    // The user_id filter is the ownership check — the service-role client bypasses RLS,
    // so it has to be in the query, not assumed from it.
    const { data: row, error } = await client
      .from('collection_items')
      .update({ hidden: body.hidden })
      .eq('id', id)
      .eq('user_id', user.userId)
      .select(ITEM_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[me-collection] Error updating item:', error.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update item' }) };
    }
    if (!row) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Item not found' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(row) };
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}
