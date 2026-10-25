// Audit 2026-10-25 #1: search-only destinations (Ampwall, Subvert, Ko-fi, Buy Me a Coffee)
// were filtered out before rendering, so a MusicBrainz-only fallback card showed nothing.
// Display keeps them, as labelled search actions after the direct links; release
// verification still ignores them; a Bandcamp search placeholder is never shown.

import { describe, it, expect } from 'vitest';
import { getDisplayPlatforms, getReleaseInfo } from '../../src/components/ResultCardUtils';
import { buildMusicBrainzFallbackResult } from '../../src/services/sources';
import type { PlatformLink, SearchResult } from '../../src/types';

const link = (sourceId: string, url: string, extra: Partial<PlatformLink> = {}): PlatformLink =>
  ({ sourceId: sourceId as PlatformLink['sourceId'], url, ...extra });

const result = (platforms: PlatformLink[]): SearchResult =>
  ({ id: 'x', name: 'X', type: 'artist', platforms } as SearchResult);

describe('getDisplayPlatforms', () => {
  it('keeps supplemental search links, after the direct ones', () => {
    const shown = getDisplayPlatforms(result([
      link('ampwall', 'https://ampwall.com/explore?searchStyle=search&query=X'),
      link('mirlo', 'https://mirlo.space/x'),
      link('kofi', 'https://duckduckgo.com/?q=site:ko-fi.com+X'),
    ]));
    expect(shown.map(p => p.sourceId)).toEqual(['mirlo', 'ampwall', 'kofi']);
  });

  it('never shows a synthesized Bandcamp search placeholder', () => {
    const shown = getDisplayPlatforms(result([
      link('bandcamp', 'https://bandcamp.com/search?q=X'),
      link('subvert', 'https://www.subvert.fm/discover?q=X&type=artist'),
    ]));
    expect(shown.map(p => p.sourceId)).toEqual(['subvert']);
  });

  it('keeps a real Bandcamp page and a direct link on a search-only platform', () => {
    const shown = getDisplayPlatforms(result([
      link('bandcamp', 'https://x.bandcamp.com'),
      link('ampwall', 'https://ampwall.com/a/x'),
    ]));
    expect(shown.map(p => p.url)).toEqual(['https://x.bandcamp.com', 'https://ampwall.com/a/x']);
  });

  it('gives a MusicBrainz-only fallback card destinations', () => {
    const fallback = buildMusicBrainzFallbackResult({ artistName: 'Nobody Indie' } as never);
    expect(fallback).not.toBeNull();
    expect(getDisplayPlatforms(fallback!).length).toBeGreaterThan(0);
  });
});

describe('getReleaseInfo still verifies against direct links only', () => {
  it('ignores a release attached to a search link', () => {
    const info = getReleaseInfo(result([
      link('ampwall', 'https://ampwall.com/explore?query=X', {
        latestRelease: { title: 'Ghost', url: 'https://ampwall.com/explore?query=X' },
      } as Partial<PlatformLink>),
    ]));
    expect(info.latestRelease).toBeUndefined();
  });
});
