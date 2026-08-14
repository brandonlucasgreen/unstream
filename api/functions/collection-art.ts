// API endpoint: /api/collection/art/{collectionItemId}
// GET — the cover art for one collection item, fetched from Bandcamp server-side.
//
// Why a proxy rather than a stored URL: Subsonic serves cover art from an authenticated
// endpoint (`getCoverArt`), and its credentials travel in the query string. Putting that URL
// in an <img src> would publish the user's Bandcamp credential to every viewer and every
// referrer log. So the image is fetched here, with the credential decrypted server-side, and
// only the bytes go out.
//
// This is what fills the gap left by release matching: art_url is populated only for items
// matched to an Unstream release (28% of a real 190-item collection when measured
// 2026-08-13), and a grid that is three-quarters empty boxes reads as broken.
//
// Cached hard at the CDN — one Bandcamp request per image per edge per month — because
// otherwise every page view would re-fetch every tile. Pagination (15 tiles a page) bounds
// the burst on a cold cache.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { decryptCredential } from './credential-crypto';
import {
  subsonicAlbumCoverArtId,
  subsonicFetchCoverArt,
  type SubsonicCredential,
} from './bandcamp-subsonic';

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const JSON_HEADERS = { ...BASE_HEADERS, 'Content-Type': 'application/json' };

/** A month at the CDN, a day in the browser. Album art for a bought record doesn't change. */
const IMAGE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=2592000, stale-while-revalidate=86400',
};

/**
 * A negative answer is cached far more briefly than an image. "No art" is usually permanent,
 * but this path also returns 404 when Bandcamp is unreachable, and caching *that* for a month
 * would turn a blip into a lasting hole in someone's collection page.
 */
const MISS_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=300',
};

interface ItemRow {
  user_id: string;
  external_id: string | null;
  provenance: string;
  hidden: boolean;
}

/** Declared so header lookups stay typed — this handler returns images as well as JSON. */
interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

async function authenticatedUserId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const { data, error } = await createClient(url, anonKey).auth.getUser(authHeader.slice(7));
  if (error || !data.user) return null;
  return data.user.id;
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  path?: string;
  pathParameters?: Record<string, string | undefined>;
}): Promise<FunctionResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const rl = await checkRateLimit(getClientIp(event.headers), 'standard', JSON_HEADERS);
  // `response` is optional on the rate-limit result, so returning it bare can hand Netlify
  // `undefined`. Substitute a plain 429 rather than relying on the caller's shape.
  if (rl.limited) {
    return rl.response ?? { statusCode: 429, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Rate limited' }) };
  }

  const itemId = (event.pathParameters?.id || event.path?.split('/').pop() || '').replace(/\/$/, '');
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid item id' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const { data: item, error: itemError } = await client
    .from('collection_items')
    .select('user_id, external_id, provenance, hidden')
    .eq('id', itemId)
    .maybeSingle<ItemRow>();

  if (itemError) {
    console.error('[collection-art] item lookup failed:', itemError.message);
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
  if (!item || !item.external_id) {
    return { statusCode: 404, headers: { ...JSON_HEADERS, ...MISS_CACHE_HEADERS }, body: JSON.stringify({ error: 'Not found' }) };
  }

  // Two ways to be allowed to see this: you own it, or it is on a page anyone can see.
  // The public test mirrors the public page exactly — purchased, not hidden, sharing on —
  // so this endpoint can never expose a tile the page itself would withhold.
  const viewerId = await authenticatedUserId(event.headers.authorization);
  let allowed = viewerId === item.user_id;

  if (!allowed) {
    if (item.provenance !== 'purchased' || item.hidden) {
      return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    }
    const { data: owner } = await client
      .from('usernames')
      .select('saved_artists_public')
      .eq('user_id', item.user_id)
      .maybeSingle();
    allowed = owner?.saved_artists_public === true;
  }

  if (!allowed) {
    // 404 rather than 403, matching the public page: don't confirm the item exists.
    return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const { data: connection } = await client
    .from('bandcamp_connections')
    .select('bandcamp_username, credential_ciphertext')
    .eq('user_id', item.user_id)
    .maybeSingle();

  if (!connection) {
    return { statusCode: 404, headers: { ...JSON_HEADERS, ...MISS_CACHE_HEADERS }, body: JSON.stringify({ error: 'No art available' }) };
  }

  let credential: SubsonicCredential;
  try {
    const { t, s } = JSON.parse(decryptCredential(connection.credential_ciphertext));
    credential = { username: connection.bandcamp_username, t, s };
  } catch {
    // Never forward the caught error: a JSON.parse failure would carry a snippet of the
    // decrypted credential in its message. Same rule as bandcamp-sync-background.
    console.error('[collection-art] credential decrypt failed');
    return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'No art available' }) };
  }

  try {
    // The album id is not guaranteed to be the cover-art id, so ask the album for it.
    const coverArtId = await subsonicAlbumCoverArtId(credential, item.external_id);
    const art = coverArtId ? await subsonicFetchCoverArt(credential, coverArtId, 600) : null;

    if (!art) {
      return { statusCode: 404, headers: { ...JSON_HEADERS, ...MISS_CACHE_HEADERS }, body: JSON.stringify({ error: 'No art available' }) };
    }

    return {
      statusCode: 200,
      headers: {
        ...BASE_HEADERS,
        ...IMAGE_CACHE_HEADERS,
        'Content-Type': art.contentType,
      },
      body: Buffer.from(art.bytes).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    // Bandcamp unreachable or erroring. A short-cached 404 so the tile falls back to its
    // title placeholder now and can recover on the next request — never a long cache, which
    // would freeze a transient failure into a permanent gap.
    console.warn('[collection-art] art fetch failed:', error instanceof Error ? error.message : String(error));
    return { statusCode: 404, headers: { ...JSON_HEADERS, ...MISS_CACHE_HEADERS }, body: JSON.stringify({ error: 'No art available' }) };
  }
}
