/**
 * Drawing the weekly Instagram cards (scripts/generate-social-posts.ts) and putting them where
 * Buffer can fetch them: a public Cloudflare R2 bucket.
 *
 * The cards used to be drawn by /api/social-card when Buffer fetched them on publish day, up to
 * two weeks after the caption was written. Drawing them here, when the week is scheduled, fixes
 * each card to its caption, and it leaves the site without its heaviest function (~130ms of CPU a
 * card, fonts and wasm bundled) or a public endpoint that fetches remote images.
 *
 * Uploads go through R2's S3-compatible API with a token scoped to the cards bucket, as
 * .github/workflows/db-backup.yml does for the backup bucket. That workflow uses the AWS CLI; a
 * script that uploads and checks each card on its own uses aws4fetch, a small S3 request signer.
 */

import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { AwsClient } from 'aws4fetch';
import { cardImageUrl, type CardData, type CardSlide } from '../api/shared/social-card';
import { renderSocialCard, sniffImageType, type CardImage } from './social-card-render';
import type { PostImage, SocialPost } from './social-post-templates';

// --- The images a card draws ---

/**
 * The image CDNs a card may draw from: where the platforms keep artist photos and release covers.
 * The same hosts ALLOWED_OUTBOUND_HOSTNAMES (api/functions/middleware.ts) lists for the card
 * endpoint, kept here so they can leave that list when the endpoint goes. Faircamp covers are on
 * the Faircamp sites themselves, which that list allows by a "faircamp" domain label.
 */
const CARD_IMAGE_HOSTS = ['cdn.mirlo.space', 'yt3.googleusercontent.com', 'images.subvert.fm', 'cdn.jam.coop'];

/**
 * Whether a card may fetch this image. The URL can be one a claimed artist typed in
 * (custom_image_url), so this is what stands between it and a request to anywhere.
 */
export function isCardImageHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname.endsWith('.bcbits.com') // Bandcamp's image host
    || CARD_IMAGE_HOSTS.includes(hostname)
    // "faircamp" as a label after the first: artist.faircamp.net, not faircamp.evil.com.
    || hostname.split('.').indexOf('faircamp') > 0;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15000;

/**
 * A record cover or artist photo at the rendition the card draws. Throws, saying why, when there
 * isn't one to draw: a host off the list, an answer that isn't the image, or a format resvg can't
 * decode (Mirlo's WebP avatars).
 */
export async function fetchCardImage(storedUrl: string): Promise<CardImage> {
  const url = cardImageUrl(storedUrl);
  if (!isCardImageHost(url)) throw new Error(`image host not allowed: ${url}`);

  // redirect: 'error' so a redirect can't take the request off the list.
  const res = await fetch(url, {
    headers: { Accept: 'image/jpeg, image/png' },
    redirect: 'error',
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`image host returned ${res.status} for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${url}`);
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new Error(`image is not a JPEG or PNG: ${url}`);
  return { mimeType, bytes };
}

function slideImage(slide: CardSlide, data: CardData): Promise<CardImage | null> {
  if (slide === 'record') return fetchCardImage(data.release!.artworkUrl!);
  if (slide === 'photo') return fetchCardImage(data.imageUrl!);
  return Promise.resolve(null);
}

// --- Where a card is stored ---

/**
 * `cards/<slug>/<slide>-<hash>.png`, the hash taken from the PNG itself. Different bytes never
 * share a key, so a later run can't overwrite a card that a post scheduled earlier points at, and
 * the object can be cached as immutable.
 */
export function cardKey(slug: string, slide: CardSlide, png: Uint8Array): string {
  // The slug rule the card endpoint's URL pattern enforced; here it keeps the key a plain path.
  if (!/^[a-z0-9-]{1,100}$/.test(slug)) throw new Error(`unexpected artist slug ${JSON.stringify(slug)}`);
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16);
  return `cards/${slug}/${slide}-${hash}.png`;
}

/** Stores a drawn card under its key and returns the URL (or local path) a post should use. */
export type CardStore = (key: string, png: Uint8Array) => Promise<string>;

/** For runs that don't schedule Instagram posts: cards are written under `dir` to be looked at. */
export function localCardStore(dir: string): CardStore {
  return async (key, png) => {
    const path = join(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png);
    return path;
  };
}

// --- The R2 bucket ---

export interface CardBucket {
  name: string;
  /** Where the bucket's objects are public (its custom domain or r2.dev address), no trailing slash. */
  publicBaseUrl: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Each setting and the environment variable it comes from. */
const CARD_BUCKET_ENV: Record<keyof CardBucket, string> = {
  name: 'SOCIAL_CARDS_BUCKET',
  publicBaseUrl: 'SOCIAL_CARDS_PUBLIC_BASE_URL',
  accountId: 'R2_ACCOUNT_ID',
  accessKeyId: 'SOCIAL_CARDS_R2_ACCESS_KEY_ID',
  secretAccessKey: 'SOCIAL_CARDS_R2_SECRET_ACCESS_KEY',
};

/**
 * The bucket's settings, or an error naming every one that's missing. A run that schedules
 * Instagram posts reads this before it generates anything, so a missing secret stops the run
 * rather than letting it go ahead without cards.
 */
export function cardBucketFromEnv(env: Record<string, string | undefined> = process.env): CardBucket {
  const missing = Object.values(CARD_BUCKET_ENV).filter(name => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Instagram cards are uploaded to R2, and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
  }
  const read = (key: keyof CardBucket) => env[CARD_BUCKET_ENV[key]]!.trim();
  const publicBaseUrl = read('publicBaseUrl').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/.test(publicBaseUrl)) {
    throw new Error(`SOCIAL_CARDS_PUBLIC_BASE_URL must be an https:// address, not "${publicBaseUrl}"`);
  }
  return {
    name: read('name'),
    publicBaseUrl,
    accountId: read('accountId'),
    accessKeyId: read('accessKeyId'),
    secretAccessKey: read('secretAccessKey'),
  };
}

/** A year, and never revalidated: a key's bytes never change. */
const CARD_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Uploads a card and returns its public URL, after fetching it from there the way Buffer will on
 * publish day. A public domain that isn't set up, or that answers with something other than the
 * PNG, is found now and the card is dropped, instead of the post failing when it publishes.
 */
export async function publishCard(bucket: CardBucket, key: string, png: Uint8Array): Promise<string> {
  const r2 = new AwsClient({ accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey, service: 's3', region: 'auto' });
  const upload = await r2.fetch(`https://${bucket.accountId}.r2.cloudflarestorage.com/${bucket.name}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'Cache-Control': CARD_CACHE_CONTROL },
    body: png,
  });
  if (!upload.ok) {
    // R2 says why in an XML body (SignatureDoesNotMatch, NoSuchBucket, AccessDenied).
    const reason = (await upload.text()).match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`R2 upload returned ${upload.status}${reason ? ` ${reason}` : ''}`);
  }
  await upload.body?.cancel();

  const url = `${bucket.publicBaseUrl}/${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  await res.body?.cancel();
  const contentType = res.headers.get('content-type');
  if (res.status !== 200 || contentType !== 'image/png') {
    throw new Error(`${url} answered ${res.status} ${contentType ?? 'with no content type'}`);
  }
  return url;
}

// --- Drawing a post's carousel ---

/**
 * The Instagram post with its carousel drawn: each card rendered, stored and in `images`, in
 * carousel order. A card is left out, and the run says so, when its image can't be fetched, it
 * doesn't render or it can't be stored. Null when no card made it, which the caller counts as a
 * failure: the post would have nothing to show.
 */
export async function withDrawnCards(
  post: SocialPost,
  artist: { name: string; slug: string },
  storeCard: CardStore
): Promise<SocialPost | null> {
  const carousel = post.carousel;
  if (!carousel) return post;

  const images: PostImage[] = [];
  for (const { slide, altText } of carousel.slides) {
    try {
      const png = await renderSocialCard(slide, carousel.data, await slideImage(slide, carousel.data));
      images.push({ url: await storeCard(cardKey(artist.slug, slide, png), png), altText });
    } catch (error) {
      console.log(`    · ${artist.name}: Instagram card ${slide} wasn't drawn (${error instanceof Error ? error.message : error}), so it's left out`);
    }
  }
  if (images.length === 0) return null;

  // The tag goes on whichever card is now first; on a carousel the first image's tags apply to all.
  if (carousel.userTags) images[0] = { ...images[0], userTags: carousel.userTags };
  return { ...post, images };
}
