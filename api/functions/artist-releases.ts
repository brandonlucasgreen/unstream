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
import { authenticateAdmin, authenticateBearer, buildCorsHeaders } from './middleware';
import { cacheDeleteByArtist } from './cache';
import { checkRateLimit, getClientIp } from './ratelimit';
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
 * Is self-serve cataloguing available to this caller yet?
 *
 * **A rollout gate, deliberately separate from the permission model.** Ownership is what
 * *authorizes* the `catalog` action — the artist asking is the artist whose catalog it is. This
 * extra admin check is a temporary limit on who can reach it at all, while the crawl behaviour
 * is watched on real traffic: an artist-triggered crawl spends the same shared hourly budget
 * every fan-triggered one does, and the newer sources (Faircamp, discovered links) have never
 * run against anything but one test instance.
 *
 * **To open this to all verified artists, delete this function and its two call sites.** Nothing
 * about the ownership checks changes — which is the point of keeping the two ideas apart rather
 * than folding the admin test into the authorization path.
 */
async function canTriggerCatalog(authHeader: string | undefined): Promise<boolean> {
  return (await authenticateAdmin(authHeader)) !== null;
}

async function purgeArtistCaches(artistName: string, slug: string): Promise<void> {
  try {
    await cacheDeleteByArtist(artistName);
  } catch (e) {
    console.error('[ArtistReleases] Redis cache purge failed:', e);
  }

  try {
    const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteId && token) {
      await fetch('https://api.netlify.com/api/v1/purge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId, cache_tags: [`artist-${slug}`] }),
      });
    }
  } catch (e) {
    console.error('[ArtistReleases] CDN cache purge failed:', e);
  }
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string>;
  body?: string | null;
}) {
  // The shared helper rather than a hand-rolled wildcard: this endpoint performs writes
  // (hide/merge/update/create/catalog), so it's restricted to unstream.stream like every other
  // authenticated surface. Safe for deploy previews — the SPA calls `/api/...` as a same-origin
  // relative request, and CORS doesn't apply to those at all.
  const origin = event.headers['origin'] || event.headers['Origin'];
  const CORS_HEADERS = buildCorsHeaders(origin, false);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const user = await authenticateBearer(authHeader);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }

  if (event.httpMethod === 'GET') {
    const slug = event.queryStringParameters?.slug;
    if (!slug) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'slug is required' }) };
    }

    const owned = await resolveOwnedArtist(slug, user.userId);
    if (!owned.ok || !owned.artistId) {
      return { statusCode: owned.status, headers: CORS_HEADERS, body: JSON.stringify({ error: owned.error }) };
    }

    const releases = await getArtistReleasesForOwner(owned.artistId);

    // `canTrigger` comes from the server rather than being re-derived in the page, so the
    // button's visibility follows the real rule instead of a copy of it — same reasoning as
    // AdminCatalogButton. `state` is three-valued (see getCatalogState): a failed read must not
    // render as a confident "never catalogued".
    const canTrigger = await canTriggerCatalog(authHeader);
    const stateResult = canTrigger ? await getCatalogState(owned.artistId) : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        releases,
        catalog: {
          canTrigger,
          state: stateResult?.ok ? stateResult.state : null,
          stateError: stateResult && !stateResult.ok ? stateResult.reason : null,
        },
      }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body: {
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

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { slug, action } = body;
  if (!slug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'slug is required' }) };
  }

  const owned = await resolveOwnedArtist(slug, user.userId);
  if (!owned.ok || !owned.artistId || !owned.artistName) {
    return { statusCode: owned.status, headers: CORS_HEADERS, body: JSON.stringify({ error: owned.error }) };
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
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` }),
    };
  }

  // Cataloguing returns 202 and is settled by polling the GET, so it doesn't fit the
  // ok/responseExtra shape the editing actions share below — handled on its own here.
  if (action === 'catalog') {
    if (!(await canTriggerCatalog(authHeader))) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Self-serve cataloguing is not available yet.' }),
      };
    }

    // Both, always: the cooldown lets the crawl run, and the detail reset is what makes it
  // re-read prices rather than only re-confirming the release list. See db.ts.
  await clearCatalogCooldown(artistId);
  await clearReleaseDetailCooldown(artistId);
    const queued = await triggerCatalogNow(artistId);
    if (!queued.ok) {
      return { statusCode: queued.status, headers: CORS_HEADERS, body: JSON.stringify({ error: queued.error }) };
    }

    // No cache purge here: nothing has been written yet. The crawl runs asynchronously, and the
    // page polls the GET for its outcome.
    return { statusCode: 202, headers: CORS_HEADERS, body: JSON.stringify({ queued: true }) };
  }

  let ok = false;
  let responseExtra: Record<string, unknown> = {};

  if (action === 'hide' || action === 'unhide') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseId must be a UUID' }) };
    }
    ok = await setReleaseHidden(artistId, releaseId, action === 'hide');
  } else if (action === 'dismiss') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseId must be a UUID' }) };
    }
    if (!(await verifyReleaseOwnership(artistId, [releaseId]))) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not your release' }) };
    }
    ok = await dismissReleaseReview(releaseId);
  } else if (action === 'merge') {
    const { keepId, dropId } = body;
    if (!keepId || !UUID_REGEX.test(keepId) || !dropId || !UUID_REGEX.test(dropId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'keepId and dropId must both be UUIDs' }) };
    }
    // Both sides, not just one — an artist could otherwise merge one of their own releases
    // with someone else's by supplying a dropId (or keepId) they don't own.
    if (!(await verifyReleaseOwnership(artistId, [keepId, dropId]))) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not your release' }) };
    }
    const result = await mergeReleases(keepId, dropId);
    ok = result.ok;
    if (!ok) {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: result.error || 'Failed to merge releases' }) };
    }
  } else if (action === 'update') {
    const { releaseId, title, releaseDate, artworkUrl } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseId must be a UUID' }) };
    }
    // The declared types are compile-time only — a client can send `"title": 123`. Without
    // this, a non-string reaches `patch.title.trim()` in db.ts and throws inside an async
    // function with no try/catch around it, surfacing as a bare 500 rather than the 400 every
    // other malformed field in this handler returns.
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'title must be a non-empty string' }) };
    }
    if (typeof title === 'string' && title.length > MAX_TITLE_LENGTH) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` }) };
    }
    // null is meaningful here — it clears the date. Anything other than null or a string is not.
    if (releaseDate !== undefined && releaseDate !== null && typeof releaseDate !== 'string') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseDate must be a string or null' }) };
    }
    if (artworkUrl !== undefined && artworkUrl !== null) {
      if (typeof artworkUrl !== 'string') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'artworkUrl must be a string or null' }) };
      }
      try {
        if (new URL(artworkUrl).protocol !== 'https:') {
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artwork URL must use HTTPS' }) };
        }
      } catch {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid artwork URL' }) };
      }
    }
    ok = await updateArtistReleaseFields(artistId, releaseId, { title, releaseDate, artworkUrl });
  } else if (action === 'reorder' || action === 'resetOrder') {
    // Two actions, one write: `resetOrder` is an empty arrangement, which the RPC reads as
    // "clear every position and go back to newest first".
    const releaseIds: unknown = action === 'resetOrder' ? [] : body.releaseIds;
    if (!Array.isArray(releaseIds) || releaseIds.some(id => typeof id !== 'string' || !UUID_REGEX.test(id))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseIds must be an array of UUIDs' }) };
    }
    if (releaseIds.length > MAX_ORDERED_RELEASES) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `releaseIds must contain ${MAX_ORDERED_RELEASES} ids or fewer` }) };
    }
    // A repeated id means the editor sent an arrangement that isn't one — the last occurrence
    // would silently win and a release the artist can see would vanish from their order.
    if (new Set(releaseIds).size !== releaseIds.length) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseIds must not repeat' }) };
    }
    // Same rule as hide/merge: owning the profile says nothing about who owns the ids in the
    // body. `verifyReleaseOwnership` reports false for an empty list, so only ask when there's
    // something to check — a reset touches nothing but this artist's own rows.
    if (releaseIds.length > 0 && !(await verifyReleaseOwnership(artistId, releaseIds as string[]))) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not your release' }) };
    }
    ok = await setReleaseDisplayOrder(artistId, releaseIds as string[]);
  } else if (action === 'addLink') {
    const { releaseId, platform, url } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseId must be a UUID' }) };
    }
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'A valid http(s) url is required' }) };
    }
    if (typeof platform !== 'string' || !isKnownPlatform(platform)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unknown platform' }) };
    }
    ok = await addArtistReleaseLink(artistId, releaseId, platform, url);
  } else {
    // create
    const { title, releaseType, releaseDate, platform, url } = body;
    if (typeof title !== 'string' || !title.trim() || typeof url !== 'string' || !isHttpUrl(url)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'title and a valid http(s) url are required' }),
      };
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` }) };
    }
    if (typeof platform !== 'string' || !isKnownPlatform(platform)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unknown platform' }) };
    }
    if (releaseDate !== undefined && releaseDate !== null && typeof releaseDate !== 'string') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseDate must be a string or null' }) };
    }
    // `releaseType` is mapped through `mapReleaseType`, which returns 'other' for anything it
    // doesn't recognize — so a junk value degrades rather than needing its own rejection. Only
    // its *type* matters here.
    if (releaseType !== undefined && typeof releaseType !== 'string') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseType must be a string' }) };
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
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: result.error || 'Failed to create release' }) };
    }
  }

  if (!ok) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Action failed' }) };
  }

  await purgeArtistCaches(owned.artistName, slug);

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, action, ...responseExtra }) };
}
