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

// Backstop against a server that never returns a short page (40 pages = 20,000 albums —
// far past any real collection). Hitting it is reported as a failure, not a truncation:
// a sync that silently stopped early would record a partial collection as complete.
const MAX_PAGES = 40;

// Bandcamp warns large libraries are slow in the beta; be generous per request.
const REQUEST_TIMEOUT_MS = 30_000;

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

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'SubsonicError';
    this.code = code;
  }
  get isAuthFailure(): boolean {
    return this.code === 40 || this.code === 41;
  }
}

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
    albumList2?: { album?: unknown[] };
  };
}

/**
 * One Subsonic call. Throws SubsonicError on transport failure, non-JSON, or a
 * status:"failed" envelope. Never includes the URL in any error.
 */
async function subsonicRequest(
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
    throw new SubsonicError(`${method}: ${aborted ? 'timed out' : 'request failed'}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new SubsonicError(`${method}: HTTP ${response.status}`);
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

function toAlbum(raw: unknown): SubsonicAlbum | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const artist = record.artist;
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
 * Fetch the whole collection via paginated getAlbumList2. Throws mid-pagination rather
 * than returning what it has: a partial result recorded as a complete sync would be a
 * silently wrong collection, which is the "never cache uncertainty" bug class.
 */
export async function subsonicFetchAllAlbums(
  credential: SubsonicCredential
): Promise<SubsonicAlbum[]> {
  const albums: SubsonicAlbum[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const envelope = await subsonicRequest(credential, 'getAlbumList2', {
      type: 'alphabeticalByArtist',
      size: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    const rawAlbums = envelope.albumList2?.album ?? [];
    for (const raw of rawAlbums) {
      const album = toAlbum(raw);
      if (album) albums.push(album);
    }
    if (rawAlbums.length < PAGE_SIZE) return albums;
  }
  throw new SubsonicError('getAlbumList2: exceeded maximum page count');
}
