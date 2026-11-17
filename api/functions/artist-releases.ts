// API endpoint: GET/POST /api/artist-releases
//
// The artist-facing half of release curation (spec §11): review what ingest catalogued, hide
// what's wrong, fix a title/date/artwork, merge a release the tier-3 dedup pass flagged as a
// possible duplicate (or one it didn't), add a platform link that's missing, add a release
// ingest never found at all, or arrange the catalogue in the order fans should see it.
//
// Ownership is the security boundary here, not an RLS policy — `releases`/`release_sources`
// have no auth.uid()-keyed write policy (see the `releases` migration's own comment), so every
// action below resolves the artist from `slug` and checks `resolveOwnedArtist` before touching
// anything, exactly like `api/functions/artist-profile.ts` does for bio/link edits.

import { withSentry } from '../lib/sentry';
import {
  getClient,
  resolveOwnedArtist,
  verifyReleaseOwnership,
  getArtistReleasesForOwner,
  setReleaseHidden,
  updateArtistReleaseFields,
  addArtistReleaseLink,
  createArtistRelease,
  dismissReleaseReview,
  mergeReleases,
  setReleaseDisplayOrder,
  getCatalogState,
  clearCatalogCooldown,
  clearReleaseDetailCooldown,
} from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { cacheDeleteByArtist } from './cache';
import { purgeArtistReleaseCaches } from './purge-cache';
import { triggerCatalogNow } from './request-catalog';
import { PLATFORMS } from '../shared/platform-registry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest title we'll store. Matches the slice in `updateArtistReleaseFields`. */
const MAX_TITLE_LENGTH = 200;

/**
 * Most releases one `reorder` may arrange. The editor sends every release it knows about, so
 * this is a bound on the array handed to Postgres, not a product limit: the largest catalogue
 * measured so far is 33.
 */
const MAX_ORDERED_RELEASES = 500;

/** Same rule as artist-profile.ts's link validation: only a protocol check, no domain allowlist. */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Is this a platform we can actually render?
 *
 * Unlike `artist_links` — which has an explicit `other_N` convention for freeform labels — a
 * `release_sources.platform` value is read back as a key into the platform registry for the
 * icon, the display name, and `payoutRank`'s ordering. An unrecognized string would render as a
 * generic badge that ranks last, i.e. a worse answer for the fan than not showing it at all, so
 * the registry is the allowlist rather than accepting any label.
 */
function isKnownPlatform(platform: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, platform);
}

/**
 * How long an artist waits between self-serve scans.
 *
 * This replaces the admin-only rollout gate the feature launched behind, and it is deliberately
 * a *different* kind of limit. Ownership is what authorizes a scan — the artist asking is the
 * artist whose catalog it is — but authorization puts no ceiling on how *often* the button may
 * be pressed, and every press is a fresh crawl of that artist's Bandcamp, Discogs and Faircamp
 * pages, spending the same shared hourly budget fan-driven cataloguing spends. Now that any
 * verified owner can reach it, that ceiling has to exist somewhere.
 *
 * A day is generous for the real need: a catalogue changes when a release ships, not hourly.
 *
 * Admins are not exempt — `/api/admin/catalog-artist` (the button on the public artist page) is
 * the unthrottled path, and keeping this one rule for everybody means the artist-facing surface
 * behaves the same way whoever is looking at it.
 */
const SCAN_COOLDOWN_HOURS = 24;

/**
 * When may this artist be scanned again — or null if now.
 *
 * Measured from `release_catalog_state.last_attempted_at`, which is the last time we crawled
 * this artist *for any reason*, so the honest phrasing in the UI is "we last checked your
 * links", not "you last scanned". Ordinary fan traffic can't hold the button down:
 * `claimArtistForCatalog` only stamps that column when a crawl actually proceeds, which for
 * demand-driven triggers is at most once every seven days.
 */
function nextScanAvailableAt(lastAttemptedAt: string | null | undefined): string | null {
  if (!lastAttemptedAt) return null;
  const readyAt = new Date(lastAttemptedAt).getTime() + SCAN_COOLDOWN_HOURS * 3600_000;
  if (!Number.isFinite(readyAt) || readyAt <= Date.now()) return null;
  return new Date(readyAt).toISOString();
}

async function purgeArtistCaches(artistName: string, slug: string): Promise<void> {
  try {
    await cacheDeleteByArtist(artistName);
  } catch (e) {
    console.error('[ArtistReleases] Redis cache purge failed:', e);
  }

  // Purges the artist page *and* every one of their release pages. The latter matters because
  // those pages are now CDN-cached for an hour rather than five minutes, so without the purge an
  // artist's own edit would sit invisible.
  await purgeArtistReleaseCaches(slug, 'ArtistReleases');
}

async function handleRequest(request: SignedInRequest): Promise<EndpointResult> {
  const { method, user, query } = request;

  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  if (method === 'GET') {
    const slug = query.slug;
    if (!slug) {
      return { status: 400, body: { error: 'slug is required' } };
    }

    const owned = await resolveOwnedArtist(slug, user.userId);
    if (!owned.ok || !owned.artistId) {
      return { status: owned.status, body: { error: owned.error } };
    }

    const releases = await getArtistReleasesForOwner(owned.artistId);

    // The cooldown is computed here rather than re-derived in the page, so the button's
    // disabled state follows the real rule instead of a copy of it. `state` is three-valued
    // (see getCatalogState): a failed read must not render as a confident "never catalogued",
    // and it must not render as a scan that's ready to run either.
    const stateResult = await getCatalogState(owned.artistId);

    return {
      status: 200,
      body: {
        // For the artist settings header, which this page shares with the profile and tips tabs.
        artistName: owned.artistName,
        releases,
        catalog: {
          state: stateResult.ok ? stateResult.state : null,
          stateError: stateResult.ok ? null : stateResult.reason,
          nextScanAvailableAt: stateResult.ok
            ? nextScanAvailableAt(stateResult.state?.last_attempted_at)
            : null,
        },
      },
    };
  }

  // POST from here on: the wrapper has already refused every other method.
  const body = request.body as {
    slug?: string;
    action?:
      | 'hide'
      | 'unhide'
      | 'dismiss'
      | 'merge'
      | 'update'
      | 'addLink'
      | 'create'
      | 'catalog'
      | 'reorder'
      | 'resetOrder';
    releaseId?: string;
    releaseIds?: unknown;
    keepId?: string;
    dropId?: string;
    title?: string;
    releaseDate?: string | null;
    artworkUrl?: string | null;
    releaseType?: string;
    platform?: string;
    url?: string;
  };

  const { slug, action } = body;
  if (!slug) {
    return { status: 400, body: { error: 'slug is required' } };
  }

  const owned = await resolveOwnedArtist(slug, user.userId);
  if (!owned.ok || !owned.artistId || !owned.artistName) {
    return { status: owned.status, body: { error: owned.error } };
  }
  const artistId = owned.artistId;

  const VALID_ACTIONS = [
    'hide',
    'unhide',
    'dismiss',
    'merge',
    'update',
    'addLink',
    'create',
    'catalog',
    'reorder',
    'resetOrder',
  ];
  if (!action || !VALID_ACTIONS.includes(action)) {
    return { status: 400, body: { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` } };
  }

  // Cataloguing returns 202 and is settled by polling the GET, so it doesn't fit the
  // ok/responseExtra shape the editing actions share below — handled on its own here.
  if (action === 'catalog') {
    // Read the state *before* clearing the cooldown below — `clearCatalogCooldown` backdates
    // `last_attempted_at` two hours to let the crawl through, so checking afterwards would be
    // checking a value this same request just wrote.
    const stateResult = await getCatalogState(artistId);
    if (!stateResult.ok) {
      // Not knowing whether a scan is allowed is not permission to run one. The same answer
      // `claimArtistForCatalog` gives itself when it can't read the row.
      return { status: 503, body: { error: stateResult.reason } };
    }

    const readyAt = nextScanAvailableAt(stateResult.state?.last_attempted_at);
    if (readyAt) {
      return {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((new Date(readyAt).getTime() - Date.now()) / 1000)),
        },
        body: {
          error: 'We checked your links in the last day — a scan runs at most once a day.',
          nextScanAvailableAt: readyAt,
        },
      };
    }

    // Both, always: the cooldown lets the crawl run, and the detail reset is what makes it
    // re-read prices rather than only re-confirming the release list. See db.ts.
    await clearCatalogCooldown(artistId);
    await clearReleaseDetailCooldown(artistId);
    const queued = await triggerCatalogNow(artistId);
    if (!queued.ok) {
      return { status: queued.status, body: { error: queued.error } };
    }

    // No cache purge here: nothing has been written yet. The crawl runs asynchronously, and the
    // page polls the GET for its outcome.
    return { status: 202, body: { queued: true } };
  }

  let ok = false;
  let responseExtra: Record<string, unknown> = {};

  if (action === 'hide' || action === 'unhide') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { status: 400, body: { error: 'releaseId must be a UUID' } };
    }
    ok = await setReleaseHidden(artistId, releaseId, action === 'hide');
  } else if (action === 'dismiss') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { status: 400, body: { error: 'releaseId must be a UUID' } };
    }
    if (!(await verifyReleaseOwnership(artistId, [releaseId]))) {
      return { status: 403, body: { error: 'Not your release' } };
    }
    ok = await dismissReleaseReview(releaseId);
  } else if (action === 'merge') {
    const { keepId, dropId } = body;
    if (!keepId || !UUID_REGEX.test(keepId) || !dropId || !UUID_REGEX.test(dropId)) {
      return { status: 400, body: { error: 'keepId and dropId must both be UUIDs' } };
    }
    // Both sides, not just one — an artist could otherwise merge one of their own releases
    // with someone else's by supplying a dropId (or keepId) they don't own.
    if (!(await verifyReleaseOwnership(artistId, [keepId, dropId]))) {
      return { status: 403, body: { error: 'Not your release' } };
    }
    const result = await mergeReleases(keepId, dropId);
    ok = result.ok;
    if (!ok) {
      return { status: 409, body: { error: result.error || 'Failed to merge releases' } };
    }
  } else if (action === 'update') {
    const { releaseId, title, releaseDate, artworkUrl } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { status: 400, body: { error: 'releaseId must be a UUID' } };
    }
    // The declared types are compile-time only — a client can send `"title": 123`. Without
    // this, a non-string reaches `patch.title.trim()` in db.ts and throws inside an async
    // function with no try/catch around it, surfacing as a bare 500 rather than the 400 every
    // other malformed field in this handler returns.
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return { status: 400, body: { error: 'title must be a non-empty string' } };
    }
    if (typeof title === 'string' && title.length > MAX_TITLE_LENGTH) {
      return { status: 400, body: { error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` } };
    }
    // null is meaningful here — it clears the date. Anything other than null or a string is not.
    if (releaseDate !== undefined && releaseDate !== null && typeof releaseDate !== 'string') {
      return { status: 400, body: { error: 'releaseDate must be a string or null' } };
    }
    if (artworkUrl !== undefined && artworkUrl !== null) {
      if (typeof artworkUrl !== 'string') {
        return { status: 400, body: { error: 'artworkUrl must be a string or null' } };
      }
      try {
        if (new URL(artworkUrl).protocol !== 'https:') {
          return { status: 400, body: { error: 'Artwork URL must use HTTPS' } };
        }
      } catch {
        return { status: 400, body: { error: 'Invalid artwork URL' } };
      }
    }
    ok = await updateArtistReleaseFields(artistId, releaseId, { title, releaseDate, artworkUrl });
  } else if (action === 'reorder' || action === 'resetOrder') {
    // Two actions, one write: `resetOrder` is an empty arrangement, which the RPC reads as
    // "clear every position and go back to newest first".
    const releaseIds: unknown = action === 'resetOrder' ? [] : body.releaseIds;
    if (!Array.isArray(releaseIds) || releaseIds.some(id => typeof id !== 'string' || !UUID_REGEX.test(id))) {
      return { status: 400, body: { error: 'releaseIds must be an array of UUIDs' } };
    }
    if (releaseIds.length > MAX_ORDERED_RELEASES) {
      return { status: 400, body: { error: `releaseIds must contain ${MAX_ORDERED_RELEASES} ids or fewer` } };
    }
    // A repeated id means the editor sent an arrangement that isn't one — the last occurrence
    // would silently win and a release the artist can see would vanish from their order.
    if (new Set(releaseIds).size !== releaseIds.length) {
      return { status: 400, body: { error: 'releaseIds must not repeat' } };
    }
    // Same rule as hide/merge: owning the profile says nothing about who owns the ids in the
    // body. `verifyReleaseOwnership` reports false for an empty list, so only ask when there's
    // something to check — a reset touches nothing but this artist's own rows.
    if (releaseIds.length > 0 && !(await verifyReleaseOwnership(artistId, releaseIds as string[]))) {
      return { status: 403, body: { error: 'Not your release' } };
    }
    ok = await setReleaseDisplayOrder(artistId, releaseIds as string[]);
  } else if (action === 'addLink') {
    const { releaseId, platform, url } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { status: 400, body: { error: 'releaseId must be a UUID' } };
    }
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      return { status: 400, body: { error: 'A valid http(s) url is required' } };
    }
    if (typeof platform !== 'string' || !isKnownPlatform(platform)) {
      return { status: 400, body: { error: 'Unknown platform' } };
    }
    ok = await addArtistReleaseLink(artistId, releaseId, platform, url);
  } else {
    // create
    const { title, releaseType, releaseDate, platform, url } = body;
    if (typeof title !== 'string' || !title.trim() || typeof url !== 'string' || !isHttpUrl(url)) {
      return { status: 400, body: { error: 'title and a valid http(s) url are required' } };
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return { status: 400, body: { error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` } };
    }
    if (typeof platform !== 'string' || !isKnownPlatform(platform)) {
      return { status: 400, body: { error: 'Unknown platform' } };
    }
    if (releaseDate !== undefined && releaseDate !== null && typeof releaseDate !== 'string') {
      return { status: 400, body: { error: 'releaseDate must be a string or null' } };
    }
    // `releaseType` is mapped through `mapReleaseType`, which returns 'other' for anything it
    // doesn't recognize — so a junk value degrades rather than needing its own rejection. Only
    // its *type* matters here.
    if (releaseType !== undefined && typeof releaseType !== 'string') {
      return { status: 400, body: { error: 'releaseType must be a string' } };
    }
    const result = await createArtistRelease(artistId, {
      title,
      releaseType: releaseType || 'other',
      releaseDate: releaseDate ?? null,
      platform,
      url,
    });
    ok = result.ok;
    responseExtra = { releaseId: result.releaseId };
    if (!ok) {
      return { status: 400, body: { error: result.error || 'Failed to create release' } };
    }
  }

  if (!ok) {
    return { status: 500, body: { error: 'Action failed' } };
  }

  await purgeArtistCaches(owned.artistName, slug);

  return { status: 200, body: { success: true, action, ...responseExtra } };
}

export const handler = withSentry(endpoint({
  // The site-only shape rather than a wildcard: this endpoint performs writes
  // (hide/merge/update/create/catalog), so it's restricted to unstream.stream like every other
  // authenticated surface. Safe for deploy previews — the SPA calls `/api/...` as a same-origin
  // relative request, and CORS doesn't apply to those at all.
  cors: 'site',
  methods: ['GET', 'POST'],
  auth: 'bearer',
  rateLimit: 'standard',
  jsonBody: true,
}, handleRequest));
