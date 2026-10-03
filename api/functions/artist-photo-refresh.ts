// Replacing a stored artist photo that its host has deleted, from the Bandcamp page the catalogue
// pass has already fetched.
//
// Search sets `artists.image_url` from the artist's Bandcamp page, but it never writes to a claimed
// artist's row, so a verified artist's photo stays whatever it was when they claimed. When they
// change their Bandcamp photo, Bandcamp deletes the old file: on 2026-10-02, 12 of the 139 verified
// artists' stored photos 404'd. The artist page then falls back to a letter, its og:image is dead,
// and the weekly social posts have to leave the photo off (scripts/social-post-photos.ts).
//
// The catalogue pass already loads the artist's /music page, whose og:image is their photo now, so
// the repair costs no Bandcamp request. It costs one request to the image host, and only when the
// page shows a different photo from the stored one.

import { photoVerdict } from '../shared/artist-photo';
import { fullSizeImageUrl } from '../shared/social-card';
import { replaceArtistPhoto } from './db';
import { isUrlHostnameAllowed } from './middleware';
import { safeFetch } from './safe-fetch';
import { parseBandcampBandIdentity, parseBandcampImage } from './search-parsers';
import { namesMatch } from './search-utils';

export interface ArtistPhotos {
  name: string;
  imageUrl: string | null;
  customImageUrl: string | null;
}

/** What the artist's Bandcamp page says about them: its band name and its photo (og:image). */
export interface BandcampPage {
  bandName: string | null;
  photo: string | null;
}

/**
 * The stored photo worth checking, or null when there is nothing to repair:
 *
 * - The artist set their own photo, which is shown instead, so the stored one isn't seen.
 * - Nothing is stored. Filling a gap in a claimed artist's profile isn't a repair.
 * - The page isn't the artist's own. A stored link can be a label's page, whose photo is the
 *   label's; the name check is the one the probe applied when it first stored a photo.
 * - The page shows no photo, or one that isn't on Bandcamp's image host. Only a Bandcamp photo
 *   replaces one, because that's where search would have found it.
 * - The page shows the same photo, at whatever size code, so it hasn't been deleted.
 */
export function storedPhotoToCheck(artist: ArtistPhotos, page: BandcampPage): string | null {
  if (artist.customImageUrl || !artist.imageUrl || !page.photo) return null;
  if (!page.bandName || !namesMatch(page.bandName, artist.name)) return null;
  if (!/^https:\/\/f\d+\.bcbits\.com\/img\//.test(page.photo)) return null;
  if (fullSizeImageUrl(artist.imageUrl) === fullSizeImageUrl(page.photo)) return null;
  return artist.imageUrl;
}

/**
 * Replace the artist's stored photo with the one on their Bandcamp page if, and only if, the stored
 * one's host says it's gone (404 or 410). A timeout, a refused fetch or a 5xx leaves it alone: a
 * host that didn't answer hasn't said the photo is gone. Never throws, because a photo is not part
 * of cataloguing and must not fail the pass.
 */
export async function refreshDeadArtistPhoto(artistId: string, artist: ArtistPhotos, html: string): Promise<void> {
  const page = { bandName: parseBandcampBandIdentity(html)?.name ?? null, photo: parseBandcampImage(html) };
  const stored = storedPhotoToCheck(artist, page);
  if (!stored || !page.photo) return;
  // A host off the outbound allowlist isn't fetched, so its photo can't be shown to be gone.
  if (!isUrlHostnameAllowed(stored)) return;

  try {
    const response = await safeFetch(stored);
    if (!response) return;
    await response.body?.cancel();
    if (photoVerdict(response.status, response.headers.get('content-type')) !== 'gone') return;

    if (await replaceArtistPhoto(artistId, stored, page.photo)) {
      console.log(`[catalog] ${artist.name}'s stored photo is gone (${response.status}); replaced with the one on their Bandcamp page`);
    }
  } catch (error) {
    console.warn(`[catalog] couldn't check ${artist.name}'s stored photo, so it stays:`, error instanceof Error ? error.message : error);
  }
}
