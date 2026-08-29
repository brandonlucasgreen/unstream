// The manifest-backed "do we publish this slug?" check behind the artist-page 404 signal.
//
// Deliberately NOT mocked: the failure mode worth guarding is the real
// data/artists-manifest.json import silently resolving to nothing, which would make the 404 signal
// permanently quiet while every unit test that mocks it kept passing.

import { describe, it, expect } from 'vitest';
import { isPublishedArtistSlug, publishedArtistSlugCount } from '../../shared/published-artist-slugs';
import { isExcludedArtistSlug } from '../../lib/excluded-artists';

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

  // `absurd` is in the manifest (generated March 2026) and on the ethical exclusion list (added
  // 2026-08-04, #413). Without the filter it counts as published, so /api/artist-page files a
  // Sentry warning every day complaining that a page we deleted on purpose returns 404 — and
  // scripts/generate-sitemap.ts keeps offering the URL to Google. Deliberately unmocked on both
  // sides: the whole point is that the two real lists disagree.
  it('does not treat an excluded artist as published', () => {
    expect(isExcludedArtistSlug('absurd')).toBe(true);
    expect(isPublishedArtistSlug('absurd')).toBe(false);
  });
});
