// API endpoint: /api/artist-promote/assets — the Promote page's asset library
// (docs/specs/release-autopost-spec.md, "Pictures, and Instagram"). Brandon, 2026-11-02.
//
//   GET    /api/artist-promote/assets?artist={slug}          the library
//   POST   /api/artist-promote/assets?artist={slug}          upload one image: { data: base64 }
//   DELETE /api/artist-promote/assets?artist={slug}&id={id}  remove one
//
// The browser resizes every image to 2,048px on its long side and re-encodes it as a JPEG before
// sending it (AssetLibraryPage), which keeps a request far under a function's 6 MB body limit.
// The server trusts none of that: it reads the bytes' own header for the type and size, and
// refuses anything that isn't a JPEG or PNG within MAX_UPLOAD_BYTES.
//
// Uploads go to autopost's "Ways to support you" posts in turn, and to campaign posts the artist
// picks them for.

import { mediaBucketFromEnv, fitsInstagram, storeImageBytes } from './autopost-media';
import { addAsset, listAssets, MAX_ASSETS, removeAsset, type PromoteAsset } from './promote-assets-db';
import { authorizePromoteRequest } from './promote-request';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { Sentry, withSentry } from '../lib/sentry';

/** After the browser's resize, a photo is well under this. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

function shown(assets: PromoteAsset[]) {
  return {
    available: true,
    max: MAX_ASSETS,
    assets: assets.map(a => ({ id: a.id, url: a.url, width: a.width, height: a.height, instagramOk: fitsInstagram(a) })),
  };
}

async function handleRequest({ method, user, query, body }: SignedInRequest): Promise<EndpointResult> {
  const auth = await authorizePromoteRequest(user, query);
  if ('response' in auth) return auth.response;
  const { artist } = auth;

  try {
    if (method === 'GET') return { status: 200, body: shown(await listAssets(artist.id)) };

    const bucket = mediaBucketFromEnv();
    if ('missing' in bucket) {
      Sentry.captureMessage('[promote-assets] the media bucket is not configured', {
        level: 'error',
        tags: { area: 'release-autopost', kind: 'bucket-missing' },
        extra: { missing: bucket.missing },
      });
      return { status: 503, body: { error: 'Uploads aren’t available right now.' } };
    }

    if (method === 'DELETE') {
      const id = query.id;
      if (!id) return { status: 400, body: { error: 'id is required' } };
      if (!(await removeAsset(bucket, artist.id, id, new Date()))) return { status: 404, body: { error: 'That image isn’t in your library' } };
      return { status: 200, body: shown(await listAssets(artist.id)) };
    }

    if (typeof body.data !== 'string') return { status: 400, body: { error: 'Send the image as base64 in data' } };
    const existing = await listAssets(artist.id);
    if (existing.length >= MAX_ASSETS) return { status: 400, body: { error: `Your library holds up to ${MAX_ASSETS} images. Remove one to add another.` } };

    const bytes = new Uint8Array(Buffer.from(body.data, 'base64'));
    if (bytes.length === 0) return { status: 400, body: { error: 'That image is empty' } };
    if (bytes.length > MAX_UPLOAD_BYTES) return { status: 413, body: { error: 'That image is too large. Try a smaller one.' } };

    let stored;
    try {
      stored = await storeImageBytes(bucket, bytes, `promote/${artist.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The bytes themselves: say so plainly. Anything else is ours to look into.
      if (/not a JPEG or PNG|size/.test(message)) return { status: 400, body: { error: 'Unstream can only use JPEG and PNG images.' } };
      throw error;
    }
    await addAsset({
      artistId: artist.id,
      userId: user.userId,
      storageKey: stored.key,
      url: stored.url,
      contentType: stored.contentType,
      width: stored.width,
      height: stored.height,
      byteSize: bytes.length,
    });
    return { status: 200, body: shown(await listAssets(artist.id)) };
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'release-autopost', kind: `promote-assets:${method}` }, extra: { artistId: artist.id } });
    return { status: 500, body: { error: 'Something went wrong. Try again in a moment.' } };
  }
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST', 'DELETE'],
  auth: 'accountWithSecondStep',
  rateLimit: 'account',
  jsonBody: true,
}, handleRequest));
