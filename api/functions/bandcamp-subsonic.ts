// Subsonic client for Bandcamp's collection API (open beta, shipped 2026-07-16).
//
// Bandcamp speaks the Subsonic protocol at one known host, so this is a Subsonic client
// pointed at one server. Kept Subsonic-shaped rather than Bandcamp-hardcoded on purpose:
// if generic servers (Funkwhale, Navidrome, Airsonic, Jellyfin) ever come back into scope
// they arrive as a group by making SUBSONIC_SERVER a parameter — see support-loop-spec.md
// Step 1, "Deferred, not discarded". Until then the host is a constant, which is what keeps
// this free of the SSRF surface a user-supplied server URL would open.
//
// Uses the ID3 endpoints (getArtists, getAlbumList2) rather than the folder-based ones —
// better-structured data for a library import.
//
// SECURITY: Subsonic authentication travels in the query string (u, t, s). Request URLs
// must therefore NEVER be logged, thrown, or attached to Sentry events. Errors carry the
// method name and an error code only.

import { createHash, randomBytes } from 'crypto';

export const SUBSONIC_SERVER = 'https://bandcamp.com/api/subsonic';

const SUBSONIC_VERSION = '1.16.1';
const CLIENT_NAME = 'unstream';

// Max page size the Subsonic spec allows for getAlbumList2.
const PAGE_SIZE = 500;

// The smallest page worth asking for. A page that keeps failing is retried smaller (see
// subsonicFetchAllAlbums) — below this the request count stops being worth the trade.
const MIN_PAGE_SIZE = 100;

// Backstop against a server that never returns a short page — far past any real collection.
// Hitting it is reported as a failure, not a truncation: a sync that silently stopped early
// would record a partial collection as complete.
const MAX_ALBUMS = 20_000;

// Bandcamp warns large libraries are slow in the beta; be generous per request.
const REQUEST_TIMEOUT_MS = 30_000;

// Backoff between retries of a transient failure. Only the collection fetch retries — it
// runs in a background function with minutes to spare, while connect runs on the request
// path where a Netlify function is killed in seconds.
const RETRY_DELAYS_MS = [1_000, 4_000];

// Artist-by-artist fallback (subsonicFetchCollection): how many getArtist calls run at once, and
// how many times each is retried. One retry, not two: a collection of a few hundred artists where
// getArtist is broken outright would otherwise spend most of the background function's 15 minutes
// sleeping between retries.
const ARTIST_CONCURRENCY = 4;
const ARTIST_RETRIES = 1;

/** The stored credential: t = md5(password + s). The password itself is never stored. */
export interface SubsonicCredential {
  username: string;
  t: string;
  s: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
  genre?: string;
  /** ISO timestamp the server reports for the album entering the library. */
  created?: string;
}

/** Subsonic error code 40 is "wrong username or password". */
export class SubsonicError extends Error {
  readonly code: number | null;
  /**
   * The server failed to answer rather than answering "no" — a 5xx, a 429, a dropped
   * connection or a timeout. Those are worth retrying; a rejected credential, a malformed
   * body or a Subsonic error envelope are the server's actual answer and are not.
   */
  readonly retryable: boolean;

  constructor(message: string, code: number | null = null, retryable = false) {
    super(message);
    this.name = 'SubsonicError';
    this.code = code;
    this.retryable = retryable;
  }
  get isAuthFailure(): boolean {
    return this.code === 40 || this.code === 41;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Derive the salted-token pair from a password, per the Subsonic spec:
 * t = md5(password + salt). This is what gets encrypted and stored; the password is
 * discarded by the caller immediately after. MD5 here is protocol-mandated, not a choice.
 */
export function deriveSubsonicToken(password: string): { t: string; s: string } {
  const s = randomBytes(8).toString('hex');
  const t = createHash('md5').update(password + s).digest('hex');
  return { t, s };
}

function buildUrl(credential: SubsonicCredential, method: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    u: credential.username,
    t: credential.t,
    s: credential.s,
    v: SUBSONIC_VERSION,
    c: CLIENT_NAME,
    f: 'json',
    ...params,
  });
  return `${SUBSONIC_SERVER}/rest/${method}.view?${query.toString()}`;
}

interface SubsonicResponseBody {
  'subsonic-response'?: {
    status?: string;
    error?: { code?: number; message?: string };
    artists?: { index?: { artist?: unknown[] }[] };
    artist?: { album?: unknown[] };
    albumList2?: { album?: unknown[] };
  };
}

/**
 * One Subsonic call. Throws SubsonicError on transport failure, non-JSON, or a
 * status:"failed" envelope. Never includes the URL in any error.
 */
async function subsonicRequestOnce(
  credential: SubsonicCredential,
  method: string,
  params: Record<string, string> = {}
): Promise<NonNullable<SubsonicResponseBody['subsonic-response']>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildUrl(credential, method, params), {
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SubsonicError(`${method}: ${aborted ? 'timed out' : 'request failed'}`, null, true);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // 5xx and 429 are the server struggling, not an answer about the collection.
    const retryable = response.status >= 500 || response.status === 429;
    throw new SubsonicError(`${method}: HTTP ${response.status}`, null, retryable);
  }

  let body: SubsonicResponseBody;
  try {
    body = (await response.json()) as SubsonicResponseBody;
  } catch {
    throw new SubsonicError(`${method}: non-JSON response`);
  }

  const envelope = body['subsonic-response'];
  if (!envelope) {
    throw new SubsonicError(`${method}: missing subsonic-response envelope`);
  }
  if (envelope.status !== 'ok') {
    const code = envelope.error?.code ?? null;
    throw new SubsonicError(
      `${method}: ${envelope.error?.message || 'server reported failure'}`,
      code
    );
  }
  return envelope;
}

/**
 * A Subsonic call that retries a transient failure. `retries` defaults to 0 because most
 * callers run on the request path, where waiting is worse than reporting.
 */
async function subsonicRequest(
  credential: SubsonicCredential,
  method: string,
  params: Record<string, string> = {},
  retries = 0
): Promise<NonNullable<SubsonicResponseBody['subsonic-response']>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await subsonicRequestOnce(credential, method, params);
    } catch (error) {
      const retryable = error instanceof SubsonicError && error.retryable;
      if (!retryable || attempt >= retries) throw error;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

/** Verify a credential works. Throws SubsonicError (isAuthFailure for bad credentials). */
export async function subsonicPing(credential: SubsonicCredential): Promise<void> {
  await subsonicRequest(credential, 'ping');
}

/** Number of artists in the collection — the "it worked" confirmation on connect. */
export async function subsonicArtistCount(credential: SubsonicCredential): Promise<number> {
  const envelope = await subsonicRequest(credential, 'getArtists');
  const indexes = envelope.artists?.index ?? [];
  return indexes.reduce((sum, idx) => sum + (idx.artist?.length ?? 0), 0);
}

/** `fallbackArtist` fills in an album listed under getArtist that doesn't repeat its artist. */
function toAlbum(raw: unknown, fallbackArtist?: string): SubsonicAlbum | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const artist = typeof record.artist === 'string' ? record.artist : fallbackArtist;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof artist !== 'string') {
    return null;
  }
  return {
    id,
    name,
    artist,
    coverArt: typeof record.coverArt === 'string' ? record.coverArt : undefined,
    year: typeof record.year === 'number' ? record.year : undefined,
    genre: typeof record.genre === 'string' ? record.genre : undefined,
    created: typeof record.created === 'string' ? record.created : undefined,
  };
}

/**
 * The `coverArt` id for one album, read from getAlbum.
 *
 * Needed because Subsonic's cover-art id is not required to equal the album id, and we
 * don't store it — collection rows keep only the album id. Returns null when the server
 * reports no art rather than throwing: a missing cover is an ordinary answer, not a fault.
 */
export async function subsonicAlbumCoverArtId(
  credential: SubsonicCredential,
  albumId: string
): Promise<string | null> {
  const envelope = await subsonicRequest(credential, 'getAlbum', { id: albumId });
  const album = (envelope as Record<string, unknown>).album;
  if (typeof album !== 'object' || album === null) return null;
  const coverArt = (album as Record<string, unknown>).coverArt;
  return typeof coverArt === 'string' && coverArt ? coverArt : null;
}

/**
 * Fetch cover-art bytes. Unlike every other call here, a successful response is an image,
 * not JSON — so a JSON body means the server is reporting an error (no art, bad id) and is
 * returned as null. Callers must treat null as "no art", never as a failure worth caching
 * as permanent.
 */
export async function subsonicFetchCoverArt(
  credential: SubsonicCredential,
  coverArtId: string,
  size?: number
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const params: Record<string, string> = { id: coverArtId };
  if (size) params.size = String(size);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildUrl(credential, 'getCoverArt', params), {
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SubsonicError(`getCoverArt: ${aborted ? 'timed out' : 'request failed'}`, null, true);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new SubsonicError(`getCoverArt: HTTP ${response.status}`, null, retryable);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return null;

  return { bytes: await response.arrayBuffer(), contentType };
}

/**
 * Add the page that failed to an error's message. Offsets and page sizes are not sensitive;
 * the request URL — which carries the credential — is still never included. Without this a
 * sync failure reports only "getAlbumList2: HTTP 500", which can't distinguish "Bandcamp is
 * down" from "Bandcamp can't build page 4 of this collection".
 */
function withPageContext(error: unknown, offset: number, size: number): unknown {
  if (!(error instanceof SubsonicError)) return error;
  return new SubsonicError(
    `${error.message} (offset ${offset}, size ${size})`,
    error.code,
    error.retryable
  );
}

/**
 * Fetch the whole collection via paginated getAlbumList2. Throws mid-pagination rather
 * than returning what it has: a partial result recorded as a complete sync would be a
 * silently wrong collection, which is the "never cache uncertainty" bug class.
 *
 * Two concessions to the beta, which returns HTTP 500 on collections it imports fine at
 * other times (Sentry, 2026-08-14):
 *   - a transient failure is retried before it is believed;
 *   - a page that still fails is asked for again, smaller, from the same offset. A 500 that
 *     only some users see, on the one call that asks for 500 records at once, reads like
 *     Bandcamp timing out while building a big page — so the page is made smaller.
 *     Halving stops at MIN_PAGE_SIZE and then throws. That alone didn't rescue the accounts
 *     that fail this way every time, so subsonicFetchCollection catches it and goes artist by
 *     artist.
 */
export async function subsonicFetchAllAlbums(
  credential: SubsonicCredential
): Promise<SubsonicAlbum[]> {
  const albums: SubsonicAlbum[] = [];
  let pageSize = PAGE_SIZE;
  let offset = 0;

  // Bounded on rows consumed, not rows kept: a server answering with full pages of entries
  // that all fail toAlbum would otherwise loop forever.
  while (offset < MAX_ALBUMS) {
    let envelope;
    try {
      envelope = await subsonicRequest(
        credential,
        'getAlbumList2',
        {
          type: 'alphabeticalByArtist',
          size: String(pageSize),
          offset: String(offset),
        },
        RETRY_DELAYS_MS.length
      );
    } catch (error) {
      if (error instanceof SubsonicError && error.retryable && pageSize > MIN_PAGE_SIZE) {
        pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
        continue;
      }
      throw withPageContext(error, offset, pageSize);
    }

    const rawAlbums = envelope.albumList2?.album ?? [];
    for (const raw of rawAlbums) {
      const album = toAlbum(raw);
      if (album) albums.push(album);
    }
    // A short page is the end of the collection. Advance by what arrived, not by what was
    // asked for, so a shrunken page can't leave a gap.
    if (rawAlbums.length < pageSize) return albums;
    offset += rawAlbums.length;
  }
  throw new SubsonicError(`getAlbumList2: collection exceeded ${MAX_ALBUMS} albums`);
}

/** What subsonicFetchCollection got, and whether it had to go the long way round. */
export interface CollectionFetch {
  albums: SubsonicAlbum[];
  /** Artists whose albums Bandcamp wouldn't send, by name, sorted. Empty unless `listFailure`. */
  missingArtists: string[];
  /** Why the album list failed, when the collection was fetched artist by artist instead. */
  listFailure: string | null;
}

/**
 * The whole collection: the album list (subsonicFetchAllAlbums), or, when Bandcamp won't send
 * that, the same albums artist by artist.
 *
 * Why the second route exists: for some collections Bandcamp's getAlbumList2 fails on the very
 * first page, at every page size, quickly and every time — one account has failed that way since
 * 2026-08-14, another since 2026-11-04 (each sync failed ~24s in, which is the retry backoff
 * alone, so Bandcamp was answering in a few hundred milliseconds, not timing out). That reads
 * like one record in the collection breaking Bandcamp's list, and getArtist confines such a
 * record to the one artist it belongs to.
 *
 * **This is the one place a sync may import less than the whole collection**, and only by naming
 * what's missing. An artist whose albums Bandcamp won't send is listed in `missingArtists` for the
 * settings page to show, never dropped silently; and if every artist fails, nothing was learned
 * about the collection, so it throws rather than reporting an empty import. A rejected credential
 * is never a reason to try another route: it throws straight away.
 */
export async function subsonicFetchCollection(credential: SubsonicCredential): Promise<CollectionFetch> {
  try {
    return { albums: await subsonicFetchAllAlbums(credential), missingArtists: [], listFailure: null };
  } catch (error) {
    if (!(error instanceof SubsonicError) || error.isAuthFailure) throw error;
    const byArtist = await subsonicFetchAlbumsByArtist(credential);
    return { ...byArtist, listFailure: error.message };
  }
}

interface ArtistEntry {
  id: string;
  name: string;
}

async function subsonicFetchAlbumsByArtist(
  credential: SubsonicCredential
): Promise<{ albums: SubsonicAlbum[]; missingArtists: string[] }> {
  const index = await subsonicRequest(credential, 'getArtists', {}, RETRY_DELAYS_MS.length);
  const artists: ArtistEntry[] = [];
  for (const bucket of index.artists?.index ?? []) {
    for (const raw of bucket.artist ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const { id, name } = raw as Record<string, unknown>;
      if (typeof id === 'string' && typeof name === 'string') artists.push({ id, name });
    }
  }

  const albums: SubsonicAlbum[] = [];
  const missingArtists: string[] = [];
  let lastFailure: SubsonicError | null = null;
  let stop: unknown = null;
  let next = 0;

  // A small pool rather than one at a time: a large collection is hundreds of artists, and the
  // background function has 15 minutes for all of them plus the import.
  const worker = async () => {
    while (stop === null && next < artists.length) {
      const artist = artists[next++];
      try {
        const envelope = await subsonicRequest(credential, 'getArtist', { id: artist.id }, ARTIST_RETRIES);
        for (const raw of envelope.artist?.album ?? []) {
          const album = toAlbum(raw, artist.name);
          if (album) albums.push(album);
        }
        if (albums.length > MAX_ALBUMS) {
          stop = new SubsonicError(`getArtist: collection exceeded ${MAX_ALBUMS} albums`);
        }
      } catch (error) {
        if (error instanceof SubsonicError && !error.isAuthFailure) {
          missingArtists.push(artist.name);
          lastFailure = error;
        } else {
          stop = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARTIST_CONCURRENCY, artists.length) }, worker));

  if (stop !== null) throw stop;
  if (artists.length > 0 && missingArtists.length === artists.length) {
    throw lastFailure ?? new SubsonicError('getArtist: every artist failed');
  }
  return { albums, missingArtists: missingArtists.sort((a, b) => a.localeCompare(b)) };
}
