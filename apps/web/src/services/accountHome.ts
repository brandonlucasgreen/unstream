import * as Sentry from '@sentry/react';

// Where a signed-in person lands when nothing more specific was asked for: their artist's
// Analytics page if they have one verified claim (Brandon, 2026-11-08), My Artists if they have
// several, otherwise their collection.
//
// `/api/artist-auth` already filters to `verified_at IS NOT NULL`, so a non-empty
// `profiles` *is* "has at least one verified artist" — there is no separate check to make,
// and /my-artists is about to ask for the same thing.

export const COLLECTION_HOME = '/my-collection';
export const ARTIST_HOME = '/my-artists';

/**
 * The landing path for this session. Falls back to the collection on any failure: the
 * collection is the right answer for most accounts and the wrong one is only ever one
 * click from the right one, so a broken profiles read must not block a sign-in.
 */
export async function resolveAccountHome(accessToken: string): Promise<string> {
  try {
    const response = await fetch('/api/artist-auth', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    // A 401 here is an expired session, which the page landed on will handle; anything
    // else failing is worth knowing about, since the same call backs /my-artists.
    if (!response.ok) {
      if (response.status !== 401) {
        Sentry.captureMessage(`accountHome: artist-auth returned ${response.status}`, {
          level: 'warning',
          tags: { context: 'accountHome.resolve' },
        });
      }
      return COLLECTION_HOME;
    }
    const data = await response.json();
    const profiles: Array<{ slug?: unknown }> = Array.isArray(data.profiles) ? data.profiles : [];
    if (profiles.length === 0) return COLLECTION_HOME;
    if (profiles.length === 1 && typeof profiles[0].slug === 'string' && profiles[0].slug) {
      return `/analytics/${encodeURIComponent(profiles[0].slug)}`;
    }
    return ARTIST_HOME;
  } catch (e) {
    Sentry.captureException(e, { extra: { context: 'accountHome.resolve' } });
    return COLLECTION_HOME;
  }
}
