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

interface MatchedArtist {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
}

interface LibraryMatches {
  /** Subsonic album id → Unstream release, where title + artist matched exactly. */
  releases: Map<string, MatchedRelease>;
  /** Unstream artist id → artist, for every album whose artist matched unambiguously. */
  artists: Map<string, MatchedArtist>;
}

/**
 * Match imported albums to Unstream artists (by normalized name) and releases (by
 * normalized artist name + normalized title — releases.match_key is already
 * normalizeForComparison output). Conservative on purpose: an ambiguous artist name — two
 * artist rows normalizing identically — matches nothing, because a wrong release_id or a
 * wrong "supported" mark asserts the wrong fact about a user's support.
 */
async function matchLibrary(albums: SubsonicAlbum[]): Promise<LibraryMatches> {
  const client = getClient();
  const matches: LibraryMatches = { releases: new Map(), artists: new Map() };
  if (!client || albums.length === 0) return matches;

  // The artists table is a few thousand rows; normalization has to happen in JS, so read
  // it once and match in memory rather than issuing a query per imported artist name.
  const artistRead = await readAllPages<{ id: string; slug: string; name: string; image_url: string | null }>(
    (from, to) => client.from('artists').select('id, slug, name, image_url').order('id').range(from, to),
    'artists (bandcamp-sync matching)'
  );
  if (!artistRead.ok) {
    // Matching is enrichment: a failed read degrades to an unmatched import, not a failed sync.
    console.warn('[bandcamp-sync] artist read failed, importing unmatched:', artistRead.reason);
    return matches;
  }

  const artistsByNorm = new Map<string, MatchedArtist | 'ambiguous'>();
  for (const row of artistRead.rows) {
    const norm = normalizeForComparison(row.name);
    if (!norm) continue;
    artistsByNorm.set(
      norm,
      artistsByNorm.has(norm)
        ? 'ambiguous'
        : { id: row.id, slug: row.slug, name: row.name, imageUrl: row.image_url }
    );
  }

  // Album -> candidate artist, and the set of artist ids whose releases we need.
  const albumArtist = new Map<string, MatchedArtist>();
  for (const album of albums) {
    const artist = artistsByNorm.get(normalizeForComparison(album.artist));
    if (!artist || artist === 'ambiguous') continue;
    albumArtist.set(album.id, artist);
    matches.artists.set(artist.id, artist);
  }
  if (matches.artists.size === 0) return matches;

  const releaseByKey = new Map<string, MatchedRelease>();
  const ids = [...matches.artists.keys()];
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
    const artist = albumArtist.get(album.id);
    if (!artist) continue;
    const release = releaseByKey.get(`${artist.id}:${normalizeForComparison(album.name)}`);
    if (release) matches.releases.set(album.id, release);
  }
  return matches;
}

/** Slugs per saved_artists read — stays far below PostgREST's 1,000-row response cap. */
const SAVED_LOOKUP_CHUNK = 100;

/**
 * Buying an artist's record IS supporting them, so a Bandcamp import marks every matched
 * artist as saved + supported (Brandon, 2026-08-09, spec open question 6). Collection and
 * saved list are two views of the same relationship.
 *
 * Three rules keep this from fighting the user:
 *   - a row the user tombstoned (deleted=true) is left completely alone — permanent
 *     dismissal is a locked spec decision and a re-sync must never resurrect it;
 *   - an already-supported row keeps its original supported_at;
 *   - only supported goes true; nothing here can ever un-support or overwrite notes.
 *
 * Failure here degrades, not fails: items are the sync's primary artifact, and the mark
 * is derived state the next re-sync recomputes.
 */
async function markArtistsSupported(userId: string, artists: MatchedArtist[]): Promise<void> {
  const client = getClient();
  if (!client || artists.length === 0) return;

  const bySlug = new Map(artists.map(a => [a.slug, a]));
  const slugs = [...bySlug.keys()];
  const existing = new Map<string, { supported: boolean; deleted: boolean }>();

  for (let i = 0; i < slugs.length; i += SAVED_LOOKUP_CHUNK) {
    const chunk = slugs.slice(i, i + SAVED_LOOKUP_CHUNK);
    const { data, error } = await client
      .from('saved_artists')
      .select('artist_slug, supported, deleted')
      .eq('user_id', userId)
      .in('artist_slug', chunk);
    if (error) {
      // Without a reliable view of existing rows we can't insert safely (we might
      // resurrect a tombstone), so skip this chunk's artists entirely.
      console.warn('[bandcamp-sync] saved_artists read failed:', error.message);
      Sentry.captureException(new Error(`saved_artists read failed: ${error.message}`), {
        tags: { function: 'bandcamp-sync' },
        extra: { stage: 'mark-supported' },
      });
      for (const slug of chunk) bySlug.delete(slug);
      continue;
    }
    for (const row of data ?? []) {
      existing.set(row.artist_slug, { supported: row.supported, deleted: row.deleted === true });
    }
  }

  const serverNow = new Date().toISOString();
  const toInsert = [...bySlug.values()]
    .filter(a => !existing.has(a.slug))
    .map(a => ({
      user_id: userId,
      artist_id: a.id,
      artist_slug: a.slug,
      artist_name: a.name,
      artist_image_url: a.imageUrl,
      supported: true,
      supported_at: serverNow,
      // Stamped server-side on insert so the row is immediately visible to the Apple
      // app's ?since= incremental pulls — same reasoning as saved-artists.ts.
      last_modified: serverNow,
    }));

  const toSupport = [...bySlug.values()]
    .filter(a => {
      const row = existing.get(a.slug);
      return row !== undefined && !row.deleted && !row.supported;
    })
    .map(a => a.slug);

  for (let i = 0; i < toInsert.length; i += SAVED_LOOKUP_CHUNK) {
    const { error } = await client
      .from('saved_artists')
      .upsert(toInsert.slice(i, i + SAVED_LOOKUP_CHUNK), { onConflict: 'user_id,artist_slug' });
    if (error) {
      console.warn('[bandcamp-sync] saved_artists insert failed:', error.message);
      Sentry.captureException(new Error(`saved_artists insert failed: ${error.message}`), {
        tags: { function: 'bandcamp-sync' },
        extra: { stage: 'mark-supported' },
      });
    }
  }

  for (let i = 0; i < toSupport.length; i += SAVED_LOOKUP_CHUNK) {
    const { error } = await client
      .from('saved_artists')
      .update({ supported: true, supported_at: serverNow, last_modified: serverNow })
      .eq('user_id', userId)
      .in('artist_slug', toSupport.slice(i, i + SAVED_LOOKUP_CHUNK));
    if (error) {
      console.warn('[bandcamp-sync] saved_artists support update failed:', error.message);
      Sentry.captureException(new Error(`saved_artists support update failed: ${error.message}`), {
        tags: { function: 'bandcamp-sync' },
        extra: { stage: 'mark-supported' },
      });
    }
  }

  if (toInsert.length > 0 || toSupport.length > 0) {
    console.log(`[bandcamp-sync] marked supported: ${toInsert.length} new, ${toSupport.length} upgraded`);
  }
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

    const matches = await matchLibrary(uniqueAlbums);

    const rows = uniqueAlbums.map(album => ({
      user_id: userId,
      source: 'bandcamp',
      external_id: album.id,
      title: album.name,
      artist_name: album.artist,
      art_url: matches.releases.get(album.id)?.artwork_url ?? null,
      acquired_at: album.created ?? null,
      provenance: 'purchased', // a Bandcamp collection is proof of purchase — spec §5
      acquisition: 'unknown',
      release_id: matches.releases.get(album.id)?.id ?? null,
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

    // Buying is supporting: mark every matched artist saved + supported. After the items
    // land — the mark is derived state, and a failure inside degrades rather than throwing.
    await markArtistsSupported(userId, [...matches.artists.values()]);

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

    console.log(`[bandcamp-sync] imported ${uniqueAlbums.length} albums (${matches.releases.size} matched to releases, ${matches.artists.size} artists)`);
    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        imported: uniqueAlbums.length,
        matched: matches.releases.size,
        artistsMarked: matches.artists.size,
      }),
    };
  } catch (error) {
    const isAuth = error instanceof SubsonicError && error.isAuthFailure;
    console.error('[bandcamp-sync] sync failed:', error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { tags: { function: 'bandcamp-sync' }, extra: { stage: 'sync' } });
    await recordFailure(
      isAuth
        ? 'Bandcamp rejected the stored login. Disconnect and reconnect with a fresh username and password from Fan Settings → Subsonic.'
        : 'The sync failed partway through. Bandcamp’s Subsonic support is in beta — use Re-sync to try again.'
    );
    return { statusCode: 500, headers: RESPONSE_HEADERS, body: JSON.stringify({ error: 'Sync failed' }) };
  }
}
