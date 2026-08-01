// The manifest-backed "do we publish this slug?" check behind the artist-page 404 signal.
//
// Deliberately NOT mocked: the failure mode worth guarding is the real
// data/artists-manifest.json import silently resolving to nothing, which would make the 404 signal
// permanently quiet while every unit test that mocks it kept passing.

import { describe, it, expect } from 'vitest';
import { isPublishedArtistSlug, publishedArtistSlugCount } from '../../shared/published-artist-slugs';

describe('published artist slugs', () => {
  it('loads the real manifest', () => {
    // Exact count will drift as artists are generated; the point is that it's populated, not 0 or 1.
    expect(publishedArtistSlugCount()).toBeGreaterThan(500);
  });

  it('recognises a slug we publish', () => {
    expect(isPublishedArtistSlug('funkadelic')).toBe(true);
  });

  it('rejects a slug we do not publish', () => {
    expect(isPublishedArtistSlug('definitely-not-an-artist-we-generated')).toBe(false);
  });

  it('is case-insensitive, since URLs arrive however they were typed', () => {
    expect(isPublishedArtistSlug('Funkadelic')).toBe(true);
  });

  it('does not treat the empty slug as published', () => {
    expect(isPublishedArtistSlug('')).toBe(false);
  });
});
