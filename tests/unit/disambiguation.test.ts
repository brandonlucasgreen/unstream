import { describe, it, expect } from 'vitest';
import {
  crossPlatformReleaseComparison,
  splitSuspiciousPlatforms,
  mergeByReleaseOverlap,
  deduplicateQobuzUrls,
  removeDeadQobuzLinks,
  preferBandcampFeaturedRelease,
  filterAndSort,
  normalizeForComparison,
  type AggregatedResult,
} from '../../netlify/functions/search-utils';

// Helper to create a test result
function makeResult(
  name: string,
  platforms: AggregatedResult['platforms'],
  opts: Partial<AggregatedResult> = {},
): AggregatedResult {
  return {
    id: normalizeForComparison(name) + (opts.id || ''),
    name,
    type: 'artist',
    platforms,
    ...opts,
  };
}

describe('crossPlatformReleaseComparison', () => {
  it('removes Qobuz when releases dont match Bandcamp', () => {
    const results = [makeResult('Matt Young', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['album a', 'album b', 'album c'] },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', allReleaseTitles: ['album x', 'album y', 'album z'] },
    ])];

    crossPlatformReleaseComparison(results);

    const qobuz = results[0].platforms.find(p => p.sourceId === 'qobuz');
    expect(qobuz).toBeUndefined();
  });

  it('keeps Qobuz when releases match Bandcamp', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album', 'album b'] },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', allReleaseTitles: ['shared album', 'album c'] },
    ])];

    crossPlatformReleaseComparison(results);

    const qobuz = results[0].platforms.find(p => p.sourceId === 'qobuz');
    expect(qobuz).toBeDefined();
  });

  it('keeps Qobuz with no release data (benefit of the doubt)', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['album a'] },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1' },
    ])];

    crossPlatformReleaseComparison(results);

    const qobuz = results[0].platforms.find(p => p.sourceId === 'qobuz');
    expect(qobuz).toBeDefined();
  });
});

describe('splitSuspiciousPlatforms', () => {
  it('splits Bandcamp with non-matching releases into separate result', () => {
    const results = [makeResult('Matt Young', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['different album'] },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', latestRelease: { title: 'Other Album', type: 'album', url: 'https://qobuz.com/1/album' }, allReleaseTitles: ['other album'] },
    ])];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated.length).toBe(2);
    const verified = disambiguated.find(r => r.matchConfidence === 'verified');
    const unverified = disambiguated.find(r => r.matchConfidence === 'unverified');
    expect(verified).toBeDefined();
    expect(unverified).toBeDefined();
    expect(unverified!.platforms[0].sourceId).toBe('bandcamp');
  });

  it('keeps Bandcamp with matching releases on the same result', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album'] },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', latestRelease: { title: 'Shared Album', type: 'album', url: 'https://qobuz.com/1/album' }, allReleaseTitles: ['shared album'] },
    ])];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated).toHaveLength(1);
    expect(disambiguated[0].matchConfidence).toBe('verified');
    expect(disambiguated[0].platforms).toHaveLength(2);
  });

  it('marks curated-only results as verified', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'faircamp', url: 'https://artist.faircamp.com' },
      { sourceId: 'jamcoop', url: 'https://jam.coop/artists/artist' },
    ])];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated[0].matchConfidence).toBe('verified');
  });

  it('marks results with no releases and no curated platforms as unverified', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'qobuz', url: 'https://qobuz.com/1' },
    ])];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated[0].matchConfidence).toBe('unverified');
  });
});

describe('mergeByReleaseOverlap', () => {
  it('merges same-name results when releases overlap', () => {
    const results: AggregatedResult[] = [
      makeResult('Artist', [
        { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album', 'album b'] },
      ], { id: 'artist-1' }),
      makeResult('Artist', [
        { sourceId: 'qobuz', url: 'https://qobuz.com/1', allReleaseTitles: ['shared album', 'album c'] },
      ], { id: 'artist-2' }),
    ];

    const merged = mergeByReleaseOverlap(results);

    expect(merged).toHaveLength(1);
    expect(merged[0].platforms).toHaveLength(2);
  });

  it('keeps same-name results separate when they share a platform', () => {
    const results: AggregatedResult[] = [
      makeResult('Matt Young', [
        { sourceId: 'bandcamp', url: 'https://mattyoungmusictx.bandcamp.com' },
      ], { id: 'matt-1' }),
      makeResult('Matt Young', [
        { sourceId: 'bandcamp', url: 'https://mattyoungmusic.bandcamp.com' },
      ], { id: 'matt-2' }),
    ];

    const merged = mergeByReleaseOverlap(results);

    expect(merged).toHaveLength(2);
  });

  it('keeps same-name results separate when releases dont overlap', () => {
    const results: AggregatedResult[] = [
      makeResult('Matt Young', [
        { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['album a'] },
      ], { id: 'matt-1' }),
      makeResult('Matt Young', [
        { sourceId: 'qobuz', url: 'https://qobuz.com/1', allReleaseTitles: ['album x'] },
      ], { id: 'matt-2' }),
    ];

    const merged = mergeByReleaseOverlap(results);

    expect(merged).toHaveLength(2);
  });
});

describe('deduplicateQobuzUrls', () => {
  it('keeps Qobuz only on the best-matching result', () => {
    const qobuzUrl = 'https://qobuz.com/interpreter/artist/123';
    const results = [
      makeResult('Artist', [
        { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared', 'other'] },
        { sourceId: 'qobuz', url: qobuzUrl, allReleaseTitles: ['shared', 'qobuz only'] },
      ], { id: 'a1' }),
      makeResult('Artist', [
        { sourceId: 'bandcamp', url: 'https://b.bandcamp.com', allReleaseTitles: ['unrelated'] },
        { sourceId: 'qobuz', url: qobuzUrl, allReleaseTitles: ['shared', 'qobuz only'] },
      ], { id: 'a2' }),
    ];

    deduplicateQobuzUrls(results);

    const r1Qobuz = results[0].platforms.find(p => p.sourceId === 'qobuz');
    const r2Qobuz = results[1].platforms.find(p => p.sourceId === 'qobuz');
    expect(r1Qobuz).toBeDefined(); // best match (1 overlap)
    expect(r2Qobuz).toBeUndefined(); // removed (0 overlap)
  });
});

describe('removeDeadQobuzLinks', () => {
  it('removes Qobuz platforms with no releases', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com' },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1' },
    ])];

    removeDeadQobuzLinks(results);

    expect(results[0].platforms).toHaveLength(1);
    expect(results[0].platforms[0].sourceId).toBe('bandcamp');
  });

  it('keeps Qobuz with releases', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', allReleaseTitles: ['album'] },
    ])];

    removeDeadQobuzLinks(results);

    expect(results[0].platforms).toHaveLength(1);
  });
});

describe('preferBandcampFeaturedRelease', () => {
  it('clears Qobuz latest release when it matches Bandcamp', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', latestRelease: { title: 'My Album', type: 'album', url: 'https://a.bandcamp.com/album/my-album' } },
      { sourceId: 'qobuz', url: 'https://qobuz.com/1', latestRelease: { title: 'My Album', type: 'album', url: 'https://qobuz.com/album' } },
    ])];

    preferBandcampFeaturedRelease(results);

    expect(results[0].platforms[0].latestRelease).toBeDefined();
    expect(results[0].platforms[1].latestRelease).toBeUndefined();
  });
});

describe('filterAndSort', () => {
  it('removes results with only search-only platforms', () => {
    const results: AggregatedResult[] = [
      makeResult('Real', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }]),
      makeResult('Search Only', [
        { sourceId: 'kofi', url: 'https://ko-fi.com/search' },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore' },
      ]),
    ];

    const filtered = filterAndSort(results, 'test');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Real');
  });

  it('sorts verified before unverified', () => {
    const results: AggregatedResult[] = [
      makeResult('A', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }], { matchConfidence: 'unverified' }),
      makeResult('B', [{ sourceId: 'bandcamp', url: 'https://b.bandcamp.com' }], { matchConfidence: 'verified' }),
    ];

    const filtered = filterAndSort(results, 'test');

    expect(filtered[0].name).toBe('B');
  });
});
