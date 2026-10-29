// Release autopost: images, kept where Buffer can fetch them (docs/specs/release-autopost-spec.md,
// "Pictures" and "Storage").
//
// **Buffer fetches a post's image on the day it publishes, not when the post is created**
// (CLAUDE.md, "Social posts": a missing image fails the post). Bandcamp deletes old files, and a
// post goes to Buffer up to three days ahead. So every image is copied into the public R2 bucket
// the weekly social cards already use when its post is pushed, and Buffer gets that copy.
//
// **All media goes through this file.** When Buffer's own media library takes uploads through
// its API, moving there is a change to this file alone (spec, "Later: Buffer's media library").
//
// The bucket settings are the social cards' own variables (scripts/social-cards.ts,
// `cardBucketFromEnv`). That module isn't imported because it pulls in the card renderer and
// its WebAssembly, which this function has no use for.

import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { isUrlHostnameAllowed } from './middleware';
import { safeFetch } from './safe-fetch';
import { cardImageUrl } from '../shared/social-card';

export interface MediaBucket {
  name: string;
  publicBaseUrl: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const BUCKET_ENV: Record<keyof MediaBucket, string> = {
  name: 'SOCIAL_CARDS_BUCKET',
  publicBaseUrl: 'SOCIAL_CARDS_PUBLIC_BASE_URL',
  accountId: 'R2_ACCOUNT_ID',
  accessKeyId: 'SOCIAL_CARDS_R2_ACCESS_KEY_ID',
  secretAccessKey: 'SOCIAL_CARDS_R2_SECRET_ACCESS_KEY',
};

/** The bucket, or the names of the settings that are missing. */
export function mediaBucketFromEnv(env: Record<string, string | undefined> = process.env): MediaBucket | { missing: string[] } {
  const missing = Object.values(BUCKET_ENV).filter(name => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const read = (key: keyof MediaBucket) => env[BUCKET_ENV[key]]!.trim();
  return {
    name: read('name'),
    publicBaseUrl: read('publicBaseUrl').replace(/\/+$/, ''),
    accountId: read('accountId'),
    accessKeyId: read('accessKeyId'),
    secretAccessKey: read('secretAccessKey'),
  };
}

export interface StoredImage {
  url: string;
  width: number;
  height: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
/** A year, never revalidated: a key is the hash of its bytes, so they never change. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Instagram takes 4:5 (portrait) to 1.91:1 (landscape). */
export function fitsInstagram(image: { width: number; height: number }): boolean {
  if (!image.width || !image.height) return false;
  const ratio = image.width / image.height;
  return ratio >= 0.8 && ratio <= 1.91;
}

/** JPEG or PNG by their first bytes; anything else (Mirlo's WebP) is refused. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/** Width and height from the file's own header, or null when it can't be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sniffImage(bytes) === 'image/png') {
    // The IHDR chunk always comes first: width and height at bytes 16 and 20.
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (sniffImage(bytes) === 'image/jpeg') {
    // Walk the segments to the first start-of-frame marker, which holds the dimensions.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const length = view.getUint16(i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      i += 2 + length;
    }
  }
  return null;
}

/**
 * Copy an image (a release cover or the artist's photo, from a database row) into R2 and return
 * its public URL and size.
 *
 * Throws, saying why, when it can't: a host off the allowlist, a 404, something that isn't a
 * JPEG or PNG, or an upload that doesn't come back from the public address the way Buffer will
 * fetch it. The caller then posts without the image, or skips Instagram.
 */
export async function storeImageFromUrl(bucket: MediaBucket, sourceUrl: string): Promise<StoredImage> {
  // Bandcamp's full-size rendition, and Mirlo's JPEG one, as the social cards use.
  const url = cardImageUrl(sourceUrl);
  if (!isUrlHostnameAllowed(url)) throw new Error(`image host not allowed: ${url}`);

  // safeFetch because the URL came from the database: it re-checks every redirect hop.
  const res = await safeFetch(url, FETCH_TIMEOUT_MS, { Accept: 'image/jpeg, image/png' });
  if (!res) throw new Error(`image refused or unreachable: ${url}`);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`image host returned ${res.status} for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${url}`);
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new Error(`image is not a JPEG or PNG: ${url}`);
  const size = imageSize(bytes);
  if (!size) throw new Error(`couldn't read the image's size: ${url}`);

  // Keyed by content, so an image posted every month is stored once.
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const key = `autopost/${hash}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;

  const uploadUrl = `https://${bucket.accountId}.r2.cloudflarestorage.com/${bucket.name}/${key}`;
  const publicUrl = `${bucket.publicBaseUrl}/${key}`;
  if (!isUrlHostnameAllowed(uploadUrl) || !isUrlHostnameAllowed(publicUrl)) {
    throw new Error(`media bucket host not allowed: ${bucket.publicBaseUrl}`);
  }

  const r2 = new AwsClient({ accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey, service: 's3', region: 'auto' });
  const upload = await r2.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Cache-Control': CACHE_CONTROL },
    body: bytes,
  });
  if (!upload.ok) {
    const reason = (await upload.text()).match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`R2 upload returned ${upload.status}${reason ? ` ${reason}` : ''}`);
  }
  await upload.body?.cancel();

  // Fetched back from the public address, as Buffer will on publish day, so a misconfigured
  // domain is found now rather than as a failed post.
  const check = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (check.status !== 200 || check.headers.get('content-type') !== mimeType) {
    throw new Error(`${publicUrl} answered ${check.status} ${check.headers.get('content-type') ?? 'with no content type'}`);
  }
  return { url: publicUrl, ...size };
}
