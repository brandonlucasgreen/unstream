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
import { resolveCollectionArtists, type CollectionResolveSummary } from './collection-matching';
import { releaseMatchKey } from './release-utils';
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

/** The stored columns a re-sync compares against before writing a row back. */
interface StoredCollectionItem {
  external_id: string;
  title: string | null;
  artist_name: string | null;
  art_url: string | null;
  acquired_at: string | null;
  release_id: string | null;
}

/**
 * Timestamp equality across serializations. Postgres reads a timestamptz back as
 * `2024-05-01T10:00:00+00:00` where Subsonic sent `2024-05-01T10:00:00Z` — a raw string
 * compare would call every row changed and quietly turn the re-sync diff into a no-op.
 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const parsedA = Date.parse(a);
  const parsedB = Date.parse(b);
  return Number.isFinite(parsedA) && Number.isFinite(parsedB) && parsedA === parsedB;
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
    // `releaseMatchKey`, not `normalizeForComparison`: the former is the function that produced
    // `releases.match_key`, and the two disagree. normalizeForComparison strips to [a-z0-9], so
    // it renders any title with no Latin characters — Japanese, Cyrillic, Greek — as the empty
    // string, which can never equal the stored key. Those albums silently never matched.
    const release = releaseByKey.get(`${artist.id}:${releaseMatchKey(album.name)}`);
    if (release) matches.releases.set(album.id, release);
  }
  return matches;
}

/** Artists per saved_artists read — stays far below PostgREST's 1,000-row response cap. */
const SAVED_LOOKUP_CHUNK = 100;

/** The saved_artists columns needed to decide insert vs. upgrade vs. leave alone. */
const SAVED_SELECT = 'id, artist_id, artist_slug, supported, deleted';

interface SavedRow {
  id: string;
  artist_id: string | null;
  artist_slug: string | null;
  supported: boolean;
  deleted: boolean;
}

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
 * **An existing row is looked up by `artist_id` as well as by slug, and matching on the slug
 * alone broke the first of those rules.** `(user_id, artist_slug)` is the table's natural key
 * (migration 014), but a row saved from a search result carries a *synthetic* slug —
 * `modelactriz`, `seoulmetro`, `qobuz-robertlogan` — that the canonical slug never equals, and
 * `artist_id` is then the only thing identifying the artist. So the slug-only check found
 * nothing and inserted a **second live row for an artist already saved** (measured on
 * production 2026-08-14: Model/Actriz, Rodney Owl and Seoul Metro each duplicated by one
 * import), and it equally missed a **tombstone** filed under the other slug, resurrecting a
 * dismissal this function promises is permanent.
 *
 * Failure here degrades, not fails: items are the sync's primary artifact, and the mark
 * is derived state the next re-sync recomputes.
 */
async function markArtistsSupported(userId: string, artists: MatchedArtist[]): Promise<void> {
  const client = getClient();
  if (!client || artists.length === 0) return;

  const serverNow = new Date().toISOString();
  const toInsert: Record<string, unknown>[] = [];
  /** Row ids, not slugs: a row matched by `artist_id` may be filed under a different slug. */
  const toSupport: string[] = [];

  for (let i = 0; i < artists.length; i += SAVED_LOOKUP_CHUNK) {
    const chunk = artists.slice(i, i + SAVED_LOOKUP_CHUNK);

    // Two reads rather than one, because a saved row can name this artist either way and
    // neither column alone finds both (see the doc comment above).
    const [byId, bySlug] = await Promise.all([
      client
        .from('saved_artists')
        .select(SAVED_SELECT)
        .eq('user_id', userId)
        .in('artist_id', chunk.map(a => a.id)),
      client
        .from('saved_artists')
        .select(SAVED_SELECT)
        .eq('user_id', userId)
        .in('artist_slug', chunk.map(a => a.slug)),
    ]);

    const failure = byId.error || bySlug.error;
    if (failure) {
      // Without a reliable view of existing rows we can't insert safely (we might
      // resurrect a tombstone), so skip this chunk's artists entirely.
      console.warn('[bandcamp-sync] saved_artists read failed:', failure.message);
      Sentry.captureException(new Error(`saved_artists read failed: ${failure.message}`), {
        tags: { function: 'bandcamp-sync' },
        extra: { stage: 'mark-supported' },
      });
      continue;
    }

    const rows = [...(byId.data ?? []), ...(bySlug.data ?? [])] as SavedRow[];

    for (const artist of chunk) {
      // Both reads can return the same row, and an already-duplicated artist returns two — so
      // decide over every candidate rather than picking one.
      const candidates = rows.filter(
        row => (row.artist_id && row.artist_id === artist.id) || row.artist_slug === artist.slug
      );

      if (candidates.length === 0) {
        toInsert.push({
          user_id: userId,
          artist_id: artist.id,
          artist_slug: artist.slug,
          artist_name: artist.name,
          artist_image_url: artist.imageUrl,
          supported: true,
          supported_at: serverNow,
          // Stamped server-side on insert so the row is immediately visible to the Apple
          // app's ?since= incremental pulls — same reasoning as saved-artists.ts.
          last_modified: serverNow,
        });
        continue;
      }

      // A tombstone wins only when nothing live is left for this artist — then the dismissal
      // is untouchable, and no row is inserted either. A tombstone sitting *beside* a live row
      // means that row was superseded, not the artist dismissed (deduplicating an account
      // leaves exactly that shape), and skipping there would strand the live row unsupported.
      const live = candidates.filter(row => !row.deleted);
      for (const row of live) {
        if (!row.supported && !toSupport.includes(row.id)) toSupport.push(row.id);
      }
    }
  }

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
      .in('id', toSupport.slice(i, i + SAVED_LOOKUP_CHUNK));
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

/**
 * Find the artists behind the collection items this account already holds.
 *
 * **Runs whether or not the fetch above succeeded, because it needs nothing the fetch
 * provides.** It reads `collection_items` that are already stored and probes
 * `<slug>.bandcamp.com/music` — neither the Subsonic API nor the credential is involved. This
 * originally sat inside the success path, which coupled it to something unrelated: a Subsonic
 * 500 is routine in this beta, and the first one in production (Sentry, 2026-08-14 — twelve
 * requests, every page size down to the floor, all failing at offset 0) also blocked discovery
 * for items imported days earlier, which had nothing to do with that failure.
 *
 * A Bandcamp-wide outage will simply make the probes inconclusive, and the probe cache refuses
 * to record an `undecided` verdict — so the worst case is a wasted pass, never a stored
 * "this artist isn't on Bandcamp".
 *
 * Never throws: the import is the primary artifact and its outcome is already decided by the
 * time this runs. Reported to Sentry rather than logged, because a pass that always fails
 * would otherwise look exactly like a collection whose artists simply aren't on Bandcamp.
 */
async function resolveArtistsSafely(userId: string): Promise<CollectionResolveSummary | null> {
  try {
    const resolved = await resolveCollectionArtists(userId);
    console.log('[bandcamp-sync] resolved collection artists:', JSON.stringify(resolved));
    return resolved;
  } catch (error) {
    console.error('[bandcamp-sync] artist resolution failed:', error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, {
      tags: { function: 'bandcamp-sync' },
      extra: { stage: 'resolve-collection-artists' },
    });
    return null;
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

  let outcome: { statusCode: number; body: Record<string, unknown> };

  try {
    let credential: SubsonicCredential;
    try {
      const { t, s } = JSON.parse(decryptCredential(connection.credential_ciphertext));
      credential = { username: connection.bandcamp_username, t, s };
    } catch {
      // Undecryptable means unusable (key rotated, blob corrupted) — the user has to
      // reconnect; retrying can never succeed.
      //
      // The caught error is deliberately NOT forwarded. If decryption succeeded but
      // JSON.parse rejected the result, V8 embeds a snippet of the parsed string in the
      // SyntaxError message — and that string is the decrypted credential. Reporting a
      // synthetic error keeps the rule absolute: the credential never reaches Sentry, even
      // inside an exception message.
      console.error('[bandcamp-sync] credential decrypt failed');
      Sentry.captureException(new Error('bandcamp credential could not be decrypted or parsed'), {
        tags: { function: 'bandcamp-sync' },
        extra: { stage: 'decrypt' },
      });
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

    // Write only what a re-sync actually changes. This used to upsert every row every time,
    // and the table's updated_at trigger guarantees an upsert dirties the row — so a re-sync
    // of a 190-album collection where nothing changed rewrote 190 rows plus their indexes to
    // say nothing, and a stalled sync retried after the 20-minute staleness window re-paid
    // that on every attempt. In the usual case the only rows worth writing are the new
    // purchases. A failed read degrades to writing everything, exactly as before — skipping a
    // real update because a read blipped is the worse trade.
    const existingRead = await readAllPages<StoredCollectionItem>(
      (from, to) => client
        .from('collection_items')
        .select('external_id, title, artist_name, art_url, acquired_at, release_id')
        .eq('user_id', userId)
        .eq('source', 'bandcamp')
        .order('external_id')
        .range(from, to),
      'collection_items (bandcamp-sync diff)'
    );
    const existingById = new Map(
      existingRead.ok ? existingRead.rows.map(row => [row.external_id, row]) : []
    );

    const toWrite = rows.filter(row => {
      const prior = existingById.get(row.external_id);
      if (!prior) return true;
      // Matching is best-effort: a null from this run means "no new information", not "unlink
      // this item" — linkCollectionItemsForArtist sets release_id after the fact, and a re-sync
      // whose artist read blipped must not undo it.
      row.release_id = row.release_id ?? prior.release_id;
      row.art_url = row.art_url ?? prior.art_url;
      return (
        row.title !== prior.title ||
        row.artist_name !== prior.artist_name ||
        row.art_url !== prior.art_url ||
        row.release_id !== prior.release_id ||
        !sameInstant(row.acquired_at, prior.acquired_at)
      );
    });

    for (let i = 0; i < toWrite.length; i += UPSERT_CHUNK) {
      const chunk = toWrite.slice(i, i + UPSERT_CHUNK);
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

    console.log(`[bandcamp-sync] imported ${uniqueAlbums.length} albums (${toWrite.length} written, ${uniqueAlbums.length - toWrite.length} unchanged, ${matches.releases.size} matched to releases, ${matches.artists.size} artists)`);

    outcome = {
      statusCode: 200,
      body: {
        imported: uniqueAlbums.length,
        matched: matches.releases.size,
        artistsMarked: matches.artists.size,
      },
    };
  } catch (error) {
    const isAuth = error instanceof SubsonicError && error.isAuthFailure;
    console.error('[bandcamp-sync] sync failed:', error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, {
      tags: { function: 'bandcamp-sync' },
      // `retryable` separates "Bandcamp couldn't answer even after retries" from a failure
      // of ours — the two look identical in the message alone.
      extra: {
        stage: 'sync',
        retryable: error instanceof SubsonicError ? error.retryable : null,
      },
    });
    await recordFailure(
      isAuth
        ? 'Bandcamp rejected the stored login. Disconnect and reconnect with a fresh username and password from Fan Settings → Subsonic.'
        : 'The sync failed partway through. Bandcamp’s Subsonic support is in beta — use Re-sync to try again.'
    );
    outcome = { statusCode: 500, body: { error: 'Sync failed' } };
  }

  // Discovery for the items we hold, on both paths — see resolveArtistsSafely.
  const resolved = await resolveArtistsSafely(userId);

  return {
    statusCode: outcome.statusCode,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify({ ...outcome.body, resolved }),
  };
}
