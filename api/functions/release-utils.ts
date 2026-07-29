// Pure utility functions for release persistence.
// No HTTP, cache, or database dependencies. Shared across:
//   - check-releases.ts (API handler)
//   - db.ts (search persistence)
//   - scripts/migrate-releases.ts (one-time migration)
//
// Follows the same pattern as search-utils.ts: pure functions, unit-testable.

/** Map a platform release type ('album'/'track') to the artist_releases release_type enum. */
export function mapReleaseType(type: 'album' | 'track'): 'album' | 'single' | 'ep' | 'compilation' {
  return type === 'track' ? 'single' : 'album';
}

/** Generate a URL-safe slug from a title string. */
export function releaseSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Streaming platforms where you listen but can't buy directly. */
export const STREAMING_PLATFORMS = new Set([
  'spotify',
  'applemusic',
  'apple_music',
  'tidal',
  'qobuz',
  'beatport',
  'hoopla',
  'freegal',
]);

/** Check if a platform is a streaming platform. */
export function isStreamingPlatform(platform: string): boolean {
  return STREAMING_PLATFORMS.has(platform.toLowerCase());
}

/**
 * Infer release type ('album' or 'track') from a Bandcamp URL path.
 * Bandcamp URLs are /album/<slug> or /track/<slug>.
 */
export function bandcampReleaseType(url: string): 'album' | 'track' {
  return url.includes('/track/') ? 'track' : 'album';
}