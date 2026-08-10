// Netlify Background Function: import a user's Bandcamp collection into collection_items.
//
// Invoked by me-bandcamp.ts on connect and re-sync. A `-background` function returns 202
// to its caller immediately and then runs for up to 15 minutes — Bandcamp warns that large
// libraries sync slowly in the beta, so this must be off the request path.
//
// Authenticated with the shared internal secret (isInternalRequest), same as
// catalog-artist-background.ts: an open endpoint that makes Unstream hit Bandcamp with a
// stored credential on demand would be both an amplifier and a credential oracle.
//
// Failure semantics — the "never cache uncertainty" rule applied to a sync: a fetch that
// dies mid-pagination throws (see subsonicFetchAllAlbums) and lands in the catch block,
// which records sync_status='error' on the connection row. It must never record a partial
// import as a completed sync — that would show a user a quietly wrong collection.

import { Sentry } from '../lib/sentry';
import { getClient, readAllPages } from './db';
import { isInternalRequest } from './middleware';
import { decryptCredential } from './credential-crypto';
import {
  subsonicFetchAllAlbums,
  SubsonicError,
  type SubsonicAlbum,
  type SubsonicCredential,
} from './bandcamp-subsonic';
import { normalizeForComparison } from './search-utils';

const RESPONSE_HEADERS = { 'Content-Type': 'application/json' };

/** Rows per upsert batch — keeps each PostgREST request comfortably sized. */
const UPSERT_CHUNK = 500;

/** Artist ids per releases lookup. Small enough that even prolific artists stay far
 *  under PostgREST's silent 1,000-row response cap. */
const RELEASE_LOOKUP_CHUNK = 50;

interface MatchedRelease {
  id: string;
  artwork_url: string | null;
}

/**
 * Match imported albums to Unstream releases by normalized artist name + normalized title
 * (releases.match_key is already normalizeForComparison output). Conservative on purpose:
 * an ambiguous artist name — two artist rows normalizing identically — matches nothing,
 * because a wrong release_id asserts the wrong record on a public page.
 */
async function matchReleases(
  albums: SubsonicAlbum[]
): Promise<Map<string, MatchedRelease>> {
  const client = getClient();
  const matches = new Map<string, MatchedRelease>();
  if (!client || albums.length === 0) return matches;

  // The artists table is a few thousand rows; normalization has to happen in JS, so read
  // it once and match in memory rather than issuing a query per imported artist name.
  const artistRead = await readAllPages<{ id: string; name: string }>(
    (from, to) => client.from('artists').select('id, name').order('id').range(from, to),
    'artists (bandcamp-sync matching)'
  );
  if (!artistRead.ok) {
    // Matching is enrichment: a failed read degrades to an unmatched import, not a failed sync.
    console.warn('[bandcamp-sync] artist read failed, importing unmatched:', artistRead.reason);
    return matches;
  }

  const artistsByNorm = new Map<string, string | 'ambiguous'>();
  for (const row of artistRead.rows) {
    const norm = normalizeForComparison(row.name);
    if (!norm) continue;
    artistsByNorm.set(norm, artistsByNorm.has(norm) ? 'ambiguous' : row.id);
  }

  // Album -> candidate artist id, and the set of artist ids whose releases we need.
  const albumArtistId = new Map<string, string>();
  const neededArtistIds = new Set<string>();
  for (const album of albums) {
    const artistId = artistsByNorm.get(normalizeForComparison(album.artist));
    if (!artistId || artistId === 'ambiguous') continue;
    albumArtistId.set(album.id, artistId);
    neededArtistIds.add(artistId);
  }
  if (neededArtistIds.size === 0) return matches;

  const releaseByKey = new Map<string, MatchedRelease>();
  const ids = [...neededArtistIds];
  for (let i = 0; i < ids.length; i += RELEASE_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + RELEASE_LOOKUP_CHUNK);
    const { data, error } = await client
      .from('releases')
      .select('id, artist_id, match_key, artwork_url')
      .in('artist_id', chunk)
      .eq('is_hidden', false);
    if (error) {
      // Matching is best-effort enrichment; a failed lookup degrades to unmatched items,
      // it doesn't fail the sync. Log so a systematic failure is visible.
      console.warn('[bandcamp-sync] release lookup failed:', error.message);
      continue;
    }
    for (const row of data ?? []) {
      releaseByKey.set(`${row.artist_id}:${row.match_key}`, {
        id: row.id,
        artwork_url: row.artwork_url,
      });
    }
  }

  for (const album of albums) {
    const artistId = albumArtistId.get(album.id);
    if (!artistId) continue;
    const release = releaseByKey.get(`${artistId}:${normalizeForComparison(album.name)}`);
    if (release) matches.set(album.id, release);
  }
  return matches;
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!isInternalRequest(event.headers.authorization)) {
    return { statusCode: 401, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let userId: string;
  try {
    const body = JSON.parse(event.body || '{}');
    userId = typeof body.userId === 'string' ? body.userId : '';
  } catch {
    return { statusCode: 400, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  if (!userId) {
    return { statusCode: 400, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'userId is required' }) };
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const { data: connection, error: connectionError } = await client
    .from('bandcamp_connections')
    .select('bandcamp_username, credential_ciphertext')
    .eq('user_id', userId)
    .maybeSingle();

  if (connectionError) {
    console.error('[bandcamp-sync] Error loading connection:', connectionError.message);
    return { statusCode: 500, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Failed to load connection' }) };
  }
  if (!connection) {
    // Disconnected between request and run — nothing to do, and no row to mark.
    console.log('[bandcamp-sync] no connection row for user — skipping');
    return { statusCode: 200, headers: RESPONSE_HEADERS, body: JSON.stringify({ skipped: true }) };
  }

  async function recordFailure(message: string) {
    await client!
      .from('bandcamp_connections')
      .update({ sync_status: 'error', sync_error: message })
      .eq('user_id', userId);
  }

  try {
    let credential: SubsonicCredential;
    try {
      const { t, s } = JSON.parse(decryptCredential(connection.credential_ciphertext));
      credential = { username: connection.bandcamp_username, t, s };
    } catch (error) {
      // Undecryptable means unusable (key rotated, blob corrupted) — the user has to
      // reconnect; retrying can never succeed.
      console.error('[bandcamp-sync] credential decrypt failed');
      Sentry.captureException(error, { tags: { function: 'bandcamp-sync' }, extra: { stage: 'decrypt' } });
      await recordFailure('The stored credential is no longer readable. Disconnect and reconnect Bandcamp.');
      return { statusCode: 500, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Credential unusable' }) };
    }

    const albums = await subsonicFetchAllAlbums(credential);

    // Dedupe by Subsonic id — a duplicate in one upsert batch is a Postgres error
    // ("cannot affect row a second time"), not a harmless overwrite.
    const byId = new Map<string, SubsonicAlbum>();
    for (const album of albums) {
      if (!byId.has(album.id)) byId.set(album.id, album);
    }
    const uniqueAlbums = [...byId.values()];

    const releaseMatches = await matchReleases(uniqueAlbums);

    const rows = uniqueAlbums.map(album => ({
      user_id: userId,
      source: 'bandcamp',
      external_id: album.id,
      title: album.name,
      artist_name: album.artist,
      art_url: releaseMatches.get(album.id)?.artwork_url ?? null,
      acquired_at: album.created ?? null,
      provenance: 'purchased', // a Bandcamp collection is proof of purchase — spec §5
      acquisition: 'unknown',
      release_id: releaseMatches.get(album.id)?.id ?? null,
      // `hidden` deliberately omitted: re-syncs must not un-hide items the user hid.
    }));

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { error } = await client
        .from('collection_items')
        .upsert(chunk, { onConflict: 'user_id,source,external_id' });
      if (error) {
        throw new Error(`collection_items upsert failed: ${error.message}`);
      }
    }

    const { error: doneError } = await client
      .from('bandcamp_connections')
      .update({
        sync_status: 'idle',
        sync_error: null,
        item_count: uniqueAlbums.length,
        last_synced_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    if (doneError) {
      throw new Error(`connection status update failed: ${doneError.message}`);
    }

    console.log(`[bandcamp-sync] imported ${uniqueAlbums.length} albums (${releaseMatches.size} matched to releases)`);
    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ imported: uniqueAlbums.length, matched: releaseMatches.size }),
    };
  } catch (error) {
    const isAuth = error instanceof SubsonicError && error.isAuthFailure;
    console.error('[bandcamp-sync] sync failed:', error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { tags: { function: 'bandcamp-sync' }, extra: { stage: 'sync' } });
    await recordFailure(
      isAuth
        ? 'Bandcamp rejected the stored credential. Disconnect and reconnect with a fresh credential from Fan Settings → Subsonic.'
        : 'The sync failed partway through. Bandcamp’s Subsonic support is in beta — use Re-sync to try again.'
    );
    return { statusCode: 500, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Sync failed' }) };
  }
}
