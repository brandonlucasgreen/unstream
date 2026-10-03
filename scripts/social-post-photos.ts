/**
 * Checking an artist's stored photo before the weekly posts carry it (scripts/generate-social-posts.ts).
 *
 * Posts attach the photo by URL, and Buffer fetches it when the post publishes, up to twelve days
 * after the Monday run. A photo the host has since deleted fails the post on publish day, so the
 * artist's spotlight is lost rather than going out without a picture. On 2026-10-02, 12 of the 139
 * verified artists' stored photos 404'd, all on Bandcamp: a claimed artist's `image_url` is never
 * refreshed (persistSearchResults skips claimed rows), so it goes stale when they change their photo.
 *
 * Only a definite answer from the host takes a photo off a post. A timeout, a network error or a
 * 5xx says nothing about the photo, so it stays and Buffer tries it again on publish day, when the
 * host is likely back (CLAUDE.md, "Never cache uncertainty": a failed lookup is not a negative result).
 */

import { fullSizeImageUrl } from '../api/shared/social-card';

export type PhotoVerdict = 'live' | 'gone' | 'unknown';

/**
 * What one response says about a photo: 404 or 410 is gone, a success carrying an image is live.
 * Everything else is unknown. A 403 or 429 may be about the request rather than the photo, and a
 * success that doesn't say it's an image is still often one: Mirlo serves its WebP avatars as
 * `application/octet-stream`.
 */
export function photoVerdict(status: number, contentType: string | null): PhotoVerdict {
  if (status === 404 || status === 410) return 'gone';
  if (status >= 200 && status < 300 && contentType?.startsWith('image/')) return 'live';
  return 'unknown';
}

const PHOTO_TIMEOUT_MS = 15000;

/**
 * Fetches the photo the way Buffer will (the same URL, a GET) and reads only the status and
 * content type. The body is dropped unread, since Bandcamp's full-size renditions run to megabytes.
 */
export async function checkPhoto(url: string): Promise<{ verdict: PhotoVerdict; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
    await res.body?.cancel();
    const contentType = res.headers.get('content-type');
    return { verdict: photoVerdict(res.status, contentType), detail: [res.status, contentType].filter(Boolean).join(' ') };
  } catch (error) {
    return { verdict: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The photo an artist's posts should carry: their stored one, or null when its host says it's gone,
 * so the Threads, Bluesky and LinkedIn posts go without one and the Instagram carousel has no photo
 * slide. Checks the full-size rendition, which is the URL the posts send.
 */
export async function livePhotoUrl(artist: { name: string; imageUrl: string | null }): Promise<string | null> {
  if (!artist.imageUrl) return null;
  const url = fullSizeImageUrl(artist.imageUrl);
  const { verdict, detail } = await checkPhoto(url);
  if (verdict === 'gone') {
    console.warn(`    ⚠ ${artist.name}: their stored photo is gone (${detail}, ${url}), so the posts go without one`);
    return null;
  }
  if (verdict === 'unknown') {
    console.warn(`    ⚠ ${artist.name}: couldn't confirm their photo (${detail}), so it stays and Buffer tries it on publish day`);
  }
  return artist.imageUrl;
}
