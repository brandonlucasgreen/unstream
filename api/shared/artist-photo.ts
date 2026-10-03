// When a stored artist photo counts as gone. Shared by the weekly social posts
// (scripts/social-post-photos.ts), which leave a gone photo off, and the catalogue pass
// (api/functions/artist-photo-refresh.ts), which replaces one.
//
// Only a definite answer from the host makes a photo gone. A timeout, a network error or a 5xx
// says nothing about the photo, so callers keep it (CLAUDE.md, "Never cache uncertainty": a failed
// lookup is not a negative result).

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
