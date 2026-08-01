// API endpoint: GET/POST /api/artist-releases
//
// The artist-facing half of release curation (spec §11): review what ingest catalogued, hide
// what's wrong, fix a title/date/artwork, merge a release the tier-3 dedup pass flagged as a
// possible duplicate (or one it didn't), add a platform link that's missing, or add a release
// ingest never found at all.
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
} from './db';
import { authenticateBearer } from './middleware';
import { cacheDeleteByArtist } from './cache';
import { checkRateLimit, getClientIp } from './ratelimit';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/** Same rule as artist-profile.ts's link validation: only a protocol check, no domain allowlist. */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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

  const user = await authenticateBearer(event.headers.authorization || event.headers.Authorization);
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
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ releases }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body: {
    slug?: string;
    action?: 'hide' | 'unhide' | 'dismiss' | 'merge' | 'update' | 'addLink' | 'create';
    releaseId?: string;
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

  const VALID_ACTIONS = ['hide', 'unhide', 'dismiss', 'merge', 'update', 'addLink', 'create'];
  if (!action || !VALID_ACTIONS.includes(action)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` }),
    };
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
    if (artworkUrl !== undefined && artworkUrl !== null) {
      try {
        if (new URL(artworkUrl).protocol !== 'https:') {
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artwork URL must use HTTPS' }) };
        }
      } catch {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid artwork URL' }) };
      }
    }
    ok = await updateArtistReleaseFields(artistId, releaseId, { title, releaseDate, artworkUrl });
  } else if (action === 'addLink') {
    const { releaseId, platform, url } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'releaseId must be a UUID' }) };
    }
    if (!platform || !url || !isHttpUrl(url)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'platform and a valid http(s) url are required' }) };
    }
    ok = await addArtistReleaseLink(artistId, releaseId, platform, url);
  } else {
    // create
    const { title, releaseType, releaseDate, platform, url } = body;
    if (!title || !platform || !url || !isHttpUrl(url)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'title, platform, and a valid http(s) url are required' }),
      };
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
