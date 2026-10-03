/**
 * Checking an artist's stored photo before the weekly posts carry it (scripts/generate-social-posts.ts).
 *
 * Posts attach the photo by URL, and Buffer fetches it when the post publishes, up to twelve days
 * after the Monday run. A photo the host has since deleted fails the post on publish day, so the
 * artist's spotlight is lost rather than going out without a picture. On 2026-10-02, 12 of the 139
 * verified artists' stored photos 404'd, all on Bandcamp. The catalogue pass now replaces those from
 * the artist's Bandcamp page (api/functions/artist-photo-refresh.ts), but a photo can still be
 * deleted between passes, and nothing refreshes the prominent artists' generated files.
 *
 * Only a definite answer from the host takes a photo off a post (photoVerdict): a timeout or a 5xx
 * keeps it, and Buffer tries it again on publish day, when the host is likely back.
 */

import { photoVerdict, type PhotoVerdict } from '../api/shared/artist-photo';
import { fullSizeImageUrl } from '../api/shared/social-card';

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
