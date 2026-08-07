// Release feeds: private per-fan, public per-handle, public per-artist.
//
//   /feed/f/{token}.ics   private, primary  — the fan's own subscription
//   /feed/f/{token}.xml   private Atom, same token
//   /u/{handle}/releases.ics|.xml   public, only for lists already opted into sharing
//   /a/{artist}/releases.xml        public per-artist
//
// A Netlify function rather than an edge function because it needs `db.ts` and `crypto`, and
// because a feed is not an SEO surface — there is no crawler-versus-browser split to make, so
// none of the SSR/edge machinery buys anything here.
//
// SECURITY POSTURE FOR THE PRIVATE FEED. Calendar clients cannot authenticate: Apple Calendar
// and Google Calendar fetch a URL on a schedule with no OAuth, no bearer header and no cookies.
// The path token is therefore the entire credential, and it is handled as one:
//
//   - **Never logged.** Not on success, not on failure, not in an error message. Path tokens
//     leak through access logs and Referer headers by default (spec §8), so nothing here ever
//     puts the raw token into a string that goes anywhere but the database query.
//   - **`Cache-Control: private, no-store`** so no shared cache or CDN retains a fan's
//     subscription list.
//   - **`X-Robots-Tag: noindex, nofollow`** in case a token URL is ever pasted somewhere public.
//   - **404, never 401, for a bad token.** A 401 invites retrying, and distinguishing
//     "well-formed but unknown" from "malformed" tells an anonymous caller more than they need.

import { getClientIp, checkRateLimit } from './ratelimit';
import {
  getFeedReleasesForArtist,
  getFeedReleasesForHandle,
  getFeedReleasesForUser,
  getFeedTokenOwner,
  resolveArtistSlugAlias,
  type FeedReleaseRow,
} from './db';
import { buildAtom, buildIcs, type FeedRelease } from '../shared/feed-format';
import { leadingOfferSummary, orderedSourcePlatforms } from '../shared/release-display';
import { PLATFORMS } from '../shared/platform-registry';

const SITE = 'https://unstream.stream';

/** Tokens are 32 bytes of base64url. Anything not that shape can't be one — refuse before querying. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

type Format = 'ics' | 'xml';

/** One response shape for every path, so callers (and tests) don't have to narrow a union. */
interface FeedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function feedHeaders(format: Format, isPrivate: boolean): Record<string, string> {
  return {
    'Content-Type':
      format === 'ics' ? 'text/calendar; charset=utf-8' : 'application/atom+xml; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=1800',
    // A calendar client fetching cross-origin (some web clients do) needs this; the body is
    // already public-by-token, so there is nothing further to protect with an origin check.
    'Access-Control-Allow-Origin': '*',
  };
}

function notFound(): FeedResponse {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
    body: 'Not found',
  };
}

/**
 * Turn stored rows into feed entries, adding the two derived display fields.
 *
 * Platform names are the registry's, not raw ids — "Jam.coop", not "jamcoop". Ordering is
 * `orderedSourcePlatforms`, artist-paying first, the same rule the release page and the alerts
 * use, so a secondhand Discogs listing never leads over a direct purchase.
 */
function toFeedReleases(rows: FeedReleaseRow[]): FeedRelease[] {
  return rows.map(row => ({
    artistName: row.artistName,
    artistSlug: row.artistSlug,
    title: row.title,
    releaseSlug: row.releaseSlug,
    releaseDate: row.releaseDate,
    offerSummary: leadingOfferSummary(row.sources),
    artworkUrl: row.artworkUrl,
    // Ordered artist-paying-first, then paired with the platform's own page so a feed entry can
    // actually link "Bandcamp" rather than just print it. `orderedSourcePlatforms` returns ids,
    // so the URL is looked up back on the row it came from.
    sources: orderedSourcePlatforms(row.sources).flatMap(id => {
      const source = row.sources.find(s => s.platform === id);
      if (!source?.url) return [];
      return [{ name: PLATFORMS[id]?.name ?? id, url: source.url }];
    }),
  }));
}

function render(
  releases: FeedReleaseRow[],
  format: Format,
  opts: { title: string; selfUrl: string; feedId: string; description?: string },
  isPrivate: boolean
): FeedResponse {
  const entries = toFeedReleases(releases);
  const body =
    format === 'ics'
      ? buildIcs(entries, opts.title, new Date(), opts.description)
      : buildAtom(entries, { title: opts.title, selfUrl: opts.selfUrl, feedId: opts.feedId });

  return { statusCode: 200, headers: feedHeaders(format, isPrivate), body };
}

/**
 * The path the client actually asked for.
 *
 * All five routes reach this function through a `status = 200` rewrite, and on a rewrite
 * `event.path` is not dependable — it can be the rewrite *target*
 * (`/.netlify/functions/feed-releases`), which carries none of the routing information. Netlify
 * always sets `rawUrl` to the full original request URL, so that is the source of truth here,
 * with `path` kept only as a fallback for the direct-invocation and test cases.
 */
export function requestPath(event: { path?: string; rawUrl?: string }): string {
  if (event.rawUrl) {
    try {
      return new URL(event.rawUrl).pathname;
    } catch {
      // fall through to `path`
    }
  }
  return event.path || '';
}

/**
 * Pull the route out of the path.
 *
 * Read from the path rather than a query parameter deliberately: `?token=` would put the
 * credential somewhere even more prone to logging, and calendar clients handle a plain path URL
 * (with a file extension they recognize) far more reliably.
 */
export function parsePath(path: string):
  | { kind: 'token'; token: string; format: Format }
  | { kind: 'handle'; handle: string; format: Format }
  | { kind: 'artist'; slug: string; format: Format }
  | null {
  const priv = path.match(/^\/feed\/f\/([^/]+)\.(ics|xml)$/);
  if (priv) return { kind: 'token', token: priv[1], format: priv[2] as Format };

  const handle = path.match(/^\/u\/([^/]+)\/releases\.(ics|xml)$/);
  if (handle) return { kind: 'handle', handle: decodeURIComponent(handle[1]), format: handle[2] as Format };

  const artist = path.match(/^\/a\/([^/]+)\/releases\.(ics|xml)$/);
  if (artist) return { kind: 'artist', slug: decodeURIComponent(artist[1]), format: artist[2] as Format };

  return null;
}

export async function handler(event: {
  httpMethod?: string;
  path?: string;
  rawUrl?: string;
  headers?: Record<string, string | undefined>;
}): Promise<FeedResponse> {
  // Calendar clients issue GET, and some probe with HEAD first.
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method not allowed' };
  }

  const route = parsePath(requestPath(event));
  if (!route) return notFound();

  // 'lenient' rather than 'strict': a household behind one IP with several subscribed clients
  // polling on their own schedules is normal traffic, not abuse.
  const rl = await checkRateLimit(getClientIp(event.headers || {}), 'lenient', {
    'Content-Type': 'text/plain',
  });
  if (rl.limited) return rl.response as FeedResponse;

  if (route.kind === 'token') {
    // Shape-check before touching the database, so a scan of junk paths costs nothing.
    if (!TOKEN_PATTERN.test(route.token)) return notFound();

    const userId = await getFeedTokenOwner(route.token);
    // Deliberately indistinguishable from a malformed token, and deliberately not logged with
    // the token value attached.
    if (!userId) return notFound();

    const releases = await getFeedReleasesForUser(userId);
    return render(
      releases,
      route.format,
      {
        title: 'Unstream — Upcoming releases',
        // Self-link uses the real URL, which necessarily contains the token; that is the one
        // place it legitimately appears, inside a body only its owner can fetch.
        selfUrl: `${SITE}/feed/f/${route.token}.${route.format}`,
        feedId: `tag:unstream.stream,2026:feed/private`,
      },
      true
    );
  }

  if (route.kind === 'handle') {
    const result = await getFeedReleasesForHandle(route.handle);
    // Null covers both "no such handle" and "not opted into sharing" — same 404 either way, so
    // the feed can't be used to enumerate which handles exist.
    if (!result) return notFound();

    return render(
      result.releases,
      route.format,
      {
        title: `Unstream — ${result.displayName}'s upcoming releases`,
        selfUrl: `${SITE}/u/${encodeURIComponent(result.displayName)}/releases.${route.format}`,
        feedId: `tag:unstream.stream,2026:feed/u/${result.displayName}`,
      },
      false
    );
  }

  let slug = route.slug;
  let artist = await getFeedReleasesForArtist(slug);

  // A retired artist slug still resolves, for the same reason release-detail.ts resolves one and
  // with more at stake: a calendar client keeps fetching whatever URL it was handed, forever and
  // silently. A 404 here is a subscription that stops updating without ever telling the fan, so
  // an artist re-slugged after somebody subscribed would quietly lose them.
  //
  // Only after the live slug misses, so a real artist who later takes that slug always wins.
  if (!artist) {
    const canonical = await resolveArtistSlugAlias(slug);
    if (canonical && canonical !== slug) {
      slug = canonical;
      artist = await getFeedReleasesForArtist(slug);
    }
  }
  if (!artist) return notFound();

  return render(
    artist.releases,
    route.format,
    {
      title: `${artist.artistName} — releases`,
      description: `Releases by ${artist.artistName}, from Unstream`,
      // Both derived from the canonical slug: the self-link should point at the address that
      // still works, and one feed id per artist means a reslug doesn't split subscribers into
      // two feeds as far as their reader is concerned.
      selfUrl: `${SITE}/a/${encodeURIComponent(slug)}/releases.${route.format}`,
      feedId: `tag:unstream.stream,2026:feed/a/${slug}`,
    },
    false
  );
}
