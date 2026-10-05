// API endpoint: GET /api/social-card/{artistSlug}/{slide}.png?platform={id}&release={releaseSlug}
//
// One slide of an indie spotlight's Instagram carousel, drawn on request from the artist's
// Unstream data: the same artist row, profile, links and catalogue /api/artist-page reads, and
// payouts from the platform registry. scripts/generate-social-posts.ts writes these URLs into
// Buffer, and Buffer fetches them when the post publishes. Rendering on request means there is
// nothing to store or clean up.
//
// The platform and release come from the URL because the generator picked them when it wrote
// the caption (see socialCardUrl). They are checked here against the artist's own data, so a URL
// can only ever draw something true: a platform the artist links to and a release in their
// catalogue there. Only claimed artists get cards, the same pool the indie spotlights draw from;
// prominent artists never reshared, and a press photo is least defensible for them.
//
// The payout is the registry's everyday figure even on Bandcamp Friday. A slide is cached for a
// month and drawn at a time nobody controls, so it can't carry a date-dependent claim; the
// caption says when it's Bandcamp Friday.

import { getArtistProfileBySlug, getArtistReleases } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isUrlHostnameAllowed } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';
import { PLATFORMS } from '../shared/platform-registry';
import {
  cardImageUrl,
  cardSlides,
  isSearchUrl,
  photoSource,
  pickCatalogueRelease,
  CARD_SLIDES,
  type CardData,
  type CardSlide,
} from '../shared/social-card';
import { renderSocialCard, sniffImageType, type CardImage } from './social-card-render';

interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A month at the CDN. The URL pins the platform and release, so the slide doesn't go stale. */
const IMAGE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=2592000, stale-while-revalidate=86400',
};

/** "Nothing to draw" is an answer, so it's cached, but briefly: the artist may add the missing piece. */
const MISS_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=300',
};

/** The database or an image host didn't answer. Never cached: that isn't "nothing to draw". */
const FAILURE_HEADERS = { ...JSON_HEADERS, 'Cache-Control': 'no-store' };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;

function notFound(reason: string): FunctionResponse {
  return { statusCode: 404, headers: { ...JSON_HEADERS, ...MISS_CACHE_HEADERS }, body: JSON.stringify({ error: reason }) };
}

function unavailable(reason: string): FunctionResponse {
  return { statusCode: 502, headers: FAILURE_HEADERS, body: JSON.stringify({ error: reason }) };
}

type ImageResult = { image: CardImage } | { missing: string } | { failed: string };

/**
 * An image for a slide, or why there isn't one. "Missing" is a definite answer (no such file, or
 * a format the renderer can't decode); "failed" means the host didn't answer properly.
 */
async function fetchCardImage(storedUrl: string): Promise<ImageResult> {
  const url = cardImageUrl(storedUrl);
  // The stored URL can be one a claimed artist typed in (custom_image_url), so this check is
  // what stands between it and a request to anywhere.
  if (!isUrlHostnameAllowed(url)) return { missing: 'Image host not allowed' };

  let res: Response;
  try {
    // redirect: 'error' so a redirect can't take the request off the allowlist.
    res = await fetch(url, {
      headers: { Accept: 'image/jpeg, image/png' },
      redirect: 'error',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    return { failed: `Image fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (res.status === 404 || res.status === 410) return { missing: 'Image not found' };
  if (!res.ok) return { failed: `Image host returned ${res.status}` };

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return { missing: 'Image too large' };
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return { missing: 'Image is not a JPEG or PNG' };
  return { image: { mimeType, bytes } };
}

const PATH_PATTERN = new RegExp(`/api/social-card/([a-z0-9-]{1,100})/(${CARD_SLIDES.join('|')})\\.png$`);

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  path?: string;
  queryStringParameters?: Record<string, string | undefined>;
}): Promise<FunctionResponse> {
  // HEAD too: an image fetcher may check the type before downloading (Netlify drops the body).
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return notFound('Not found');

  const match = (event.path ?? '').match(PATH_PATTERN);
  const platformId = event.queryStringParameters?.platform ?? '';
  const releaseSlug = event.queryStringParameters?.release ?? null;
  const platformMeta = PLATFORMS[platformId];
  if (!match || !platformMeta || (releaseSlug !== null && !/^[a-z0-9-]{1,200}$/.test(releaseSlug))) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid card URL' }) };
  }
  const [, artistSlug, slideName] = match;
  const slide = slideName as CardSlide;

  // 'lenient', not 'standard': the weekly generator renders every card once to check it, from
  // one IP and in the same minute as its /api/artist-page reads, and 'standard' is one 30/min
  // bucket shared by both. The other callers are Buffer and the CDN in front of this, so the
  // limit only bites someone rendering cards in a loop.
  const rl = await checkRateLimit(getClientIp(event.headers), 'lenient', JSON_HEADERS);
  if (rl.limited) {
    return rl.response ?? { statusCode: 429, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Rate limited' }) };
  }

  const { bundle, failed } = await getArtistProfileBySlug(artistSlug);
  if (failed) return unavailable('Artist lookup failed');
  if (!bundle) return notFound('Artist not found');

  const { artist, profile, links } = bundle;
  // Same claimed test as /api/artist-page and the artist-page-static edge function.
  if (artist.match_confidence !== 'claimed' || !profile?.verified_at) return notFound('Cards are for claimed artists');
  if (!links.some(l => l.platform === platformId && !isSearchUrl(l.url))) return notFound('Artist has no link on this platform');

  let release: CardData['release'] = null;
  if (slide === 'record') {
    if (!releaseSlug) return notFound('No release named');
    const { releases } = await getArtistReleases(artist.id, 60);
    const found = releases.find(r =>
      r.slug === releaseSlug && r.status === 'released' && r.sources.some(s => s.platform === platformId)
    );
    if (!found) return notFound('Release not found on this platform');
    // "Latest" by the rule the caption used. If the artist has put out something newer since the
    // post was written, the slide stops calling this one their latest, which is still true.
    const picked = pickCatalogueRelease(releases, platformId);
    release = {
      title: found.title.trim(),
      type: found.releaseType,
      latest: !!picked?.latest && picked.slug === found.slug,
      artworkUrl: found.artworkUrl,
    };
  }

  const data: CardData = {
    artistName: artist.name,
    location: artist.city || artist.country || null,
    platform: { id: platformId, name: platformMeta.name, payout: platformMeta.payoutPercent ?? null },
    release,
    // The artist page's choice: their own image when they've set one.
    imageUrl: profile.custom_image_url || artist.image_url || null,
  };
  if (!cardSlides(data).includes(slide)) return notFound('Nothing to draw on this slide');

  let image: CardImage | null = null;
  const imageUrl = slide === 'record' ? data.release!.artworkUrl! : slide === 'photo' ? data.imageUrl! : null;
  if (imageUrl) {
    // A photo goes on a slide only when the credit line can say where it came from.
    if (slide === 'photo' && !photoSource(imageUrl)) return notFound('Photo has no known source to credit');
    const result = await fetchCardImage(imageUrl);
    if ('failed' in result) {
      console.warn(`[social-card] ${artistSlug}/${slide}: ${result.failed}`);
      return unavailable(result.failed);
    }
    if ('missing' in result) return notFound(result.missing);
    image = result.image;
  }

  try {
    const png = await renderSocialCard(slide, data, image);
    return {
      statusCode: 200,
      headers: { ...IMAGE_CACHE_HEADERS, 'Content-Type': 'image/png' },
      body: Buffer.from(png).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    Sentry.captureException(error, { tags: { slug: artistSlug, slide }, extra: { context: 'social-card.render' } });
    console.error('[social-card] render failed:', error);
    return { statusCode: 500, headers: FAILURE_HEADERS, body: JSON.stringify({ error: 'Render failed' }) };
  }
}

export const handler = withSentry(handleRequest);
