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
import { authorizePromoteRequest, parseBody, type PromoteEvent } from './promote-request';
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

async function handleRequest(event: PromoteEvent) {
  const auth = await authorizePromoteRequest(event, ['GET', 'POST', 'DELETE']);
  if ('response' in auth) return auth.response;
  const { artist, userId, respond } = auth;

  try {
    if (event.httpMethod === 'GET') return respond(200, shown(await listAssets(artist.id)));

    const bucket = mediaBucketFromEnv();
    if ('missing' in bucket) {
      Sentry.captureMessage('[promote-assets] the media bucket is not configured', {
        level: 'error',
        tags: { area: 'release-autopost', kind: 'bucket-missing' },
        extra: { missing: bucket.missing },
      });
      return respond(503, { error: 'Uploads aren’t available right now.' });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return respond(400, { error: 'id is required' });
      if (!(await removeAsset(bucket, artist.id, id, new Date()))) return respond(404, { error: 'That image isn’t in your library' });
      return respond(200, shown(await listAssets(artist.id)));
    }

    const body = parseBody(event);
    if (!body || typeof body.data !== 'string') return respond(400, { error: 'Send the image as base64 in data' });
    const existing = await listAssets(artist.id);
    if (existing.length >= MAX_ASSETS) return respond(400, { error: `Your library holds up to ${MAX_ASSETS} images. Remove one to add another.` });

    const bytes = new Uint8Array(Buffer.from(body.data, 'base64'));
    if (bytes.length === 0) return respond(400, { error: 'That image is empty' });
    if (bytes.length > MAX_UPLOAD_BYTES) return respond(413, { error: 'That image is too large. Try a smaller one.' });

    let stored;
    try {
      stored = await storeImageBytes(bucket, bytes, `promote/${artist.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The bytes themselves: say so plainly. Anything else is ours to look into.
      if (/not a JPEG or PNG|size/.test(message)) return respond(400, { error: 'Unstream can only use JPEG and PNG images.' });
      throw error;
    }
    await addAsset({
      artistId: artist.id,
      userId,
      storageKey: stored.key,
      url: stored.url,
      contentType: stored.contentType,
      width: stored.width,
      height: stored.height,
      byteSize: bytes.length,
    });
    return respond(200, shown(await listAssets(artist.id)));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'release-autopost', kind: `promote-assets:${event.httpMethod}` }, extra: { artistId: artist.id } });
    return respond(500, { error: 'Something went wrong. Try again in a moment.' });
  }
}

export const handler = withSentry(handleRequest);
