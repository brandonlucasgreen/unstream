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

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { decryptCredential } from './credential-crypto';
import { isValidCollectionArtToken } from './collection-utils';
import {
  subsonicAlbumCoverArtId,
  subsonicFetchCoverArt,
  type SubsonicCredential,
} from './bandcamp-subsonic';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

/** A month at the CDN, a day in the browser. Album art for a bought record doesn't change. */
const IMAGE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400',
  'CDN-Cache-Control': 'public, s-maxage=2592000, stale-while-revalidate=86400',
};

/**
 * A negative answer is cached far more briefly than an image. "No art" is usually permanent,
 * but this path also returns 404 when Bandcamp is unreachable, and caching *that* for a month
 * would turn a blip into a lasting hole in someone's collection page.
 */
const MISS_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'CDN-Cache-Control': 'public, s-maxage=300',
};

interface ItemRow {
  user_id: string;
  external_id: string | null;
  art_ref: string | null;
  provenance: string;
  hidden: boolean;
}

interface ConnectionRow {
  bandcamp_username: string;
  credential_ciphertext: string;
}

/**
 * The owner's Bandcamp connection, cached per warm invocation. A collection page fires 12-15
 * art requests in one burst and every one needs the same connection row — this makes that one
 * read instead of fifteen. Short TTL, module-scoped: nothing new at rest, and a disconnect is
 * honoured within ten minutes (sooner in practice — a disconnect that deletes items makes the
 * item lookup 404 first).
 */
const CONNECTION_CACHE_TTL_MS = 10 * 60 * 1000;
const connectionCache = new Map<string, { row: ConnectionRow | null; expires: number }>();

/** Test hook: module state would otherwise leak one case's connection into the next. */
export function clearConnectionCacheForTests(): void {
  connectionCache.clear();
}

async function connectionForUser(
  client: NonNullable<ReturnType<typeof getClient>>,
  userId: string
): Promise<ConnectionRow | null> {
  const cached = connectionCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.row;

  const { data, error } = await client
    .from('bandcamp_connections')
    .select('bandcamp_username, credential_ciphertext')
    .eq('user_id', userId)
    .maybeSingle();

  // A failed read is not "no connection" — don't cache it, just answer this request.
  if (error) {
    console.error('[collection-art] connection lookup failed:', error.message);
    return null;
  }
  connectionCache.set(userId, { row: (data as ConnectionRow | null) ?? null, expires: Date.now() + CONNECTION_CACHE_TTL_MS });
  return (data as ConnectionRow | null) ?? null;
}

async function handleRequest({ path, query }: PublicRequest): Promise<EndpointResult> {
  const itemId = (path.split('/').pop() || '').replace(/\/$/, '');
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) {
    return { status: 400, body: { error: 'Invalid item id' } };
  }

  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  const { data: item, error: itemError } = await client
    .from('collection_items')
    .select('user_id, external_id, art_ref, provenance, hidden')
    .eq('id', itemId)
    .maybeSingle<ItemRow>();

  if (itemError) {
    console.error('[collection-art] item lookup failed:', itemError.message);
    return { status: 500, body: { error: 'Internal server error' } };
  }
  if (!item || !item.external_id) {
    return { status: 404, body: { error: 'Not found' }, headers: MISS_CACHE_HEADERS };
  }

  // Two ways to be allowed to see this, checked cheapest first:
  //
  // 1. The URL carries a valid token, minted by an endpoint that already decided this viewer
  //    may see this item (the owner's dashboard, or the public page after its own filters).
  //    This is the only path a browser's <img> tag can actually take with credentials — images
  //    carry no Authorization header, which is why non-public owners used to 404 on their own
  //    dashboard art — and it costs zero extra reads.
  // 2. It is on a page anyone can see — the legacy bare-URL path, kept for URLs minted before
  //    tokens existed (u-handle's crawler pages also still mint bare URLs; the check mirrors
  //    the public page exactly: purchased, not hidden, sharing on).
  //
  // There was a third until 2026-11-16: the owner's own sign-in token in an Authorization
  // header. No client ever sent one, and it could not be made safe: the answer is cached at the
  // CDN by URL for a month, so art served to its owner that way would then have been served to
  // anyone who asked for the same bare URL. Whatever decides access has to be in the URL.
  let allowed = isValidCollectionArtToken(itemId, query.t);

  if (!allowed) {
    if (item.provenance !== 'purchased' || item.hidden) {
      return { status: 404, body: { error: 'Not found' } };
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
    return { status: 404, body: { error: 'Not found' } };
  }

  const connection = await connectionForUser(client, item.user_id);

  if (!connection) {
    return { status: 404, body: { error: 'No art available' }, headers: MISS_CACHE_HEADERS };
  }

  let credential: SubsonicCredential;
  try {
    const { t, s } = JSON.parse(decryptCredential(connection.credential_ciphertext));
    credential = { username: connection.bandcamp_username, t, s };
  } catch {
    // Never forward the caught error: a JSON.parse failure would carry a snippet of the
    // decrypted credential in its message. Same rule as bandcamp-sync-background.
    console.error('[collection-art] credential decrypt failed');
    return { status: 404, body: { error: 'No art available' } };
  }

  try {
    // The album id is not guaranteed to be the cover-art id. The sync stores the real one on
    // the item (`art_ref`); asking the album is the fallback for rows imported before that
    // column existed, and costs one extra authenticated Bandcamp request.
    const coverArtId = item.art_ref ?? await subsonicAlbumCoverArtId(credential, item.external_id);
    const art = coverArtId ? await subsonicFetchCoverArt(credential, coverArtId, 600) : null;

    if (!art) {
      return { status: 404, body: { error: 'No art available' }, headers: MISS_CACHE_HEADERS };
    }

    return {
      status: 200,
      raw: Buffer.from(art.bytes).toString('base64'),
      headers: {
        ...IMAGE_CACHE_HEADERS,
        'Content-Type': art.contentType,
      },
      isBase64Encoded: true,
    };
  } catch (error) {
    // Bandcamp unreachable or erroring. A short-cached 404 so the tile falls back to its
    // title placeholder now and can recover on the next request — never a long cache, which
    // would freeze a transient failure into a permanent gap.
    console.warn('[collection-art] art fetch failed:', error instanceof Error ? error.message : String(error));
    return { status: 404, body: { error: 'No art available' }, headers: MISS_CACHE_HEADERS };
  }
}

export const handler = withSentry(endpoint({
  // Any origin, deliberately. The answer is an image that browsers load through <img>, which
  // never consults CORS, and it is cached at the CDN by URL for a month, so an origin echoed per
  // request (account-cors.ts) would be frozen into the cache for whoever asked first. It takes
  // no sign-in token (see "Two ways to be allowed" above), and nothing here changes account state.
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  // 'lenient', not 'standard'. One collection page renders 15 tiles and most of them miss
  // `art_url` (only ~28% of a real import matches an Unstream release), so a single page view
  // fires a dozen or more requests here. On the 30/min 'standard' bucket that spends a
  // person's whole budget in two page views and 429s them out of their own settings and
  // release lists — which is exactly the failure the lenient tier's own comment describes for
  // typeahead. High-frequency and low-cost (a CDN hit after the first view) is the same shape.
  rateLimit: 'lenient',
  jsonBody: false,
}, handleRequest));
