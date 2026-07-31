import { describe, it, expect } from 'vitest';
import {
  attachAmpwallAndSearchLinks,
  splitSuspiciousPlatforms,
  mergeByReleaseOverlap,
  filterAndSort,
  normalizeForComparison,
  applyMergeOverrides,
  type AggregatedResult,
  type MergeOverride,
} from '../../../../api/functions/search-utils';

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

describe('splitSuspiciousPlatforms', () => {
  it('splits Bandcamp with non-matching releases into separate result', () => {
    const results = [makeResult('Matt Young', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['different album'] },
      { sourceId: 'faircamp', url: 'https://a.faircamp.net', latestRelease: { title: 'Other Album', type: 'album', url: 'https://a.faircamp.net/other-album' }, allReleaseTitles: ['other album'] },
    ])];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated.length).toBe(2);
    const verified = disambiguated.find(r => r.matchConfidence === 'verified');
    const unverified = disambiguated.find(r => r.matchConfidence === 'unverified');
    expect(verified).toBeDefined();
    expect(unverified).toBeDefined();
    expect(unverified!.platforms[0].sourceId).toBe('bandcamp');
    // Only this branch actually compared releases, so only this branch may claim
    // the result conflicts with another one. The UI warning keys off the reason.
    expect(unverified!.unverifiedReason).toBe('conflicting-releases');
  });

  it('keeps Bandcamp with matching releases on the same result', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album'] },
      { sourceId: 'faircamp', url: 'https://a.faircamp.net', latestRelease: { title: 'Shared Album', type: 'album', url: 'https://a.faircamp.net/shared-album' }, allReleaseTitles: ['shared album'] },
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
    // Nothing was compared, so this must not be reported as a conflict. A
    // MusicBrainz-only card lands here and is usually the only result on the page.
    expect(disambiguated[0].unverifiedReason).toBe('no-release-data');
  });

  it('verifies a result MusicBrainz confirmed, with no releases and no curated platform', () => {
    // The Nine Inch Nails / Viagra Boys case: MusicBrainz knows exactly who this is
    // and supplied their real links, but nothing we can parse releases from lists
    // them. That is not grounds for a warning.
    const results = [makeResult('Nine Inch Nails', [
      { sourceId: 'officialsite', url: 'https://www.nin.com/' },
      { sourceId: 'discogs', url: 'https://www.discogs.com/artist/4192' },
    ], { musicBrainzConfirmed: true })];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated[0].matchConfidence).toBe('verified');
    expect(disambiguated[0].unverifiedReason).toBeUndefined();
  });

  it('clears the unverified reason when a result is upgraded to verified', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album'] },
      { sourceId: 'mirlo', url: 'https://mirlo.space/artist', latestRelease: { title: 'Shared Album', type: 'album', url: 'https://mirlo.space/artist/shared' }, allReleaseTitles: ['shared album'] },
    ], { matchConfidence: 'unverified', unverifiedReason: 'no-release-data' })];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated[0].matchConfidence).toBe('verified');
    expect(disambiguated[0].unverifiedReason).toBeUndefined();
  });
});

describe('mergeByReleaseOverlap', () => {
  it('merges same-name results when releases overlap', () => {
    const results: AggregatedResult[] = [
      makeResult('Artist', [
        { sourceId: 'bandcamp', url: 'https://a.bandcamp.com', allReleaseTitles: ['shared album', 'album b'] },
      ], { id: 'artist-1' }),
      makeResult('Artist', [
        { sourceId: 'faircamp', url: 'https://a.faircamp.net', allReleaseTitles: ['shared album', 'album c'] },
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
        { sourceId: 'faircamp', url: 'https://a.faircamp.net', allReleaseTitles: ['album x'] },
      ], { id: 'matt-2' }),
    ];

    const merged = mergeByReleaseOverlap(results);

    expect(merged).toHaveLength(2);
  });
});

describe('attachAmpwallAndSearchLinks', () => {
  it('adds search-only links for Bandcamp artists', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://artist.bandcamp.com' },
    ])];

    attachAmpwallAndSearchLinks(results, new Map());

    const kofi = results[0].platforms.find(p => p.sourceId === 'kofi');
    const bmc = results[0].platforms.find(p => p.sourceId === 'buymeacoffee');
    const ampwall = results[0].platforms.find(p => p.sourceId === 'ampwall');
    expect(kofi).toBeDefined();
    expect(bmc).toBeDefined();
    expect(ampwall).toBeDefined();
    expect(ampwall!.url).toContain('ampwall.com/explore');
  });

  it('prefers API-matched Ampwall over search fallback', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://artist.bandcamp.com' },
    ])];

    attachAmpwallAndSearchLinks(results, new Map([['artist', 'https://ampwall.com/artist/artist']]));

    const ampwall = results[0].platforms.find(p => p.sourceId === 'ampwall');
    expect(ampwall!.url).toBe('https://ampwall.com/artist/artist');
  });

  it('sorts search-only links after real platforms', () => {
    const results = [makeResult('Artist', [
      { sourceId: 'bandcamp', url: 'https://artist.bandcamp.com' },
    ])];

    attachAmpwallAndSearchLinks(results, new Map());

    const platformIds = results[0].platforms.map(p => p.sourceId);
    expect(platformIds[0]).toBe('bandcamp');
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

describe('applyMergeOverrides', () => {
  function makeOverride(
    groupName: string,
    platformUrls: string[],
    opts: Partial<MergeOverride> = {},
  ): MergeOverride {
    return {
      id: 'test-id',
      group_name: groupName,
      platform_urls: platformUrls,
      excluded_urls: [],
      canonical_image_url: null,
      ...opts,
    };
  }

  it('merges two results with matching platform URLs', () => {
    const results = [
      makeResult('Gooseworx', [
        { sourceId: 'bandcamp', url: 'https://gooseworx.bandcamp.com' },
      ]),
      makeResult('Gooseworx', [
        { sourceId: 'qobuz', url: 'https://www.qobuz.com/us-en/interpreter/gooseworx/123' },
      ], { id: '-qobuz' }),
    ];

    const overrides = [makeOverride('Gooseworx', [
      'https://gooseworx.bandcamp.com',
      'https://www.qobuz.com/us-en/interpreter/gooseworx/123',
    ])];

    applyMergeOverrides(results, overrides);

    // Override creates its own result with both platform URLs
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Gooseworx');
    const sourceIds = results[0].platforms.map(p => p.sourceId);
    expect(sourceIds).toContain('bandcamp');
    expect(sourceIds).toContain('qobuz');
    expect(results[0].matchConfidence).toBe('verified');
    expect(results[0].overrideMerged).toBe(true);
  });

  it('creates override result even when only one search result existed', () => {
    const results = [
      makeResult('Gooseworx', [
        { sourceId: 'bandcamp', url: 'https://gooseworx.bandcamp.com' },
      ]),
    ];

    const overrides = [makeOverride('Gooseworx', [
      'https://gooseworx.bandcamp.com',
      'https://www.qobuz.com/us-en/interpreter/gooseworx/123',
    ])];

    applyMergeOverrides(results, overrides);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Gooseworx');
    expect(results[0].overrideMerged).toBe(true);
    expect(results[0].matchConfidence).toBe('verified');
    // Has both override URLs plus search-only links
    const sourceIds = results[0].platforms.map(p => p.sourceId);
    expect(sourceIds).toContain('bandcamp');
    expect(sourceIds).toContain('qobuz');
  });

  it('injects missing override URLs that search did not return', () => {
    const results = [
      makeResult('Gooseworx', [
        { sourceId: 'bandcamp', url: 'https://gooseworx.bandcamp.com' },
      ]),
    ];

    const overrides = [makeOverride('Gooseworx', [
      'https://gooseworx.bandcamp.com',
      'https://www.qobuz.com/us-en/interpreter/gooseworx/123',
    ])];

    applyMergeOverrides(results, overrides);

    expect(results).toHaveLength(1);
    expect(results[0].platforms.map(p => p.sourceId)).toContain('qobuz');
    expect(results[0].platforms.find(p => p.sourceId === 'qobuz')?.url)
      .toBe('https://www.qobuz.com/us-en/interpreter/gooseworx/123');
    expect(results[0].overrideMerged).toBe(true);
  });

  it('override result only contains URLs from override list, not from search results', () => {
    const results = [
      makeResult('TestArtist', [
        { sourceId: 'bandcamp', url: 'https://testartist.bandcamp.com' },
        { sourceId: 'kofi', url: 'https://ko-fi.com/bogus' },
      ]),
      makeResult('TestArtist', [
        { sourceId: 'qobuz', url: 'https://www.qobuz.com/test/123' },
      ], { id: '-qobuz' }),
    ];

    const overrides = [makeOverride('TestArtist', [
      'https://testartist.bandcamp.com',
      'https://www.qobuz.com/test/123',
    ])];

    applyMergeOverrides(results, overrides);

    expect(results).toHaveLength(1);
    // The bogus ko-fi URL from search results is NOT on the override result
    const realPlatforms = results[0].platforms.filter(p =>
      p.url === 'https://testartist.bandcamp.com' || p.url === 'https://www.qobuz.com/test/123'
    );
    expect(realPlatforms).toHaveLength(2);
  });

  it('uses canonical image when provided', () => {
    const results = [
      makeResult('TestArtist', [
        { sourceId: 'bandcamp', url: 'https://test.bandcamp.com' },
      ], { imageUrl: 'https://old-image.jpg' }),
      makeResult('TestArtist', [
        { sourceId: 'qobuz', url: 'https://qobuz.com/test' },
      ], { id: '-qobuz' }),
    ];

    const overrides = [makeOverride('TestArtist', [
      'https://test.bandcamp.com',
      'https://qobuz.com/test',
    ], {
      canonical_image_url: 'https://canonical-image.jpg',
    })];

    applyMergeOverrides(results, overrides);

    expect(results[0].imageUrl).toBe('https://canonical-image.jpg');
  });

  it('matches URLs case-insensitively and ignores trailing slashes', () => {
    const results = [
      makeResult('TestArtist', [
        { sourceId: 'bandcamp', url: 'https://Test.Bandcamp.com/' },
      ]),
      makeResult('TestArtist', [
        { sourceId: 'qobuz', url: 'https://Qobuz.com/Test/' },
      ], { id: '-qobuz' }),
    ];

    const overrides = [makeOverride('TestArtist', [
      'https://test.bandcamp.com',
      'https://qobuz.com/test',
    ])];

    applyMergeOverrides(results, overrides);

    expect(results).toHaveLength(1);
    expect(results[0].overrideMerged).toBe(true);
  });

  it('override-merged results are not split by splitSuspiciousPlatforms', () => {
    const results = [makeResult('Gooseworx', [
      { sourceId: 'bandcamp', url: 'https://gooseworx.bandcamp.com', latestRelease: { title: 'A', type: 'album' as const, url: 'https://x' } },
      { sourceId: 'qobuz', url: 'https://qobuz.com/gooseworx' },
    ], { overrideMerged: true })];

    const disambiguated = splitSuspiciousPlatforms(results);

    expect(disambiguated).toHaveLength(1);
    expect(disambiguated[0].platforms).toHaveLength(2);
    expect(disambiguated[0].overrideMerged).toBe(true);
  });

  it('creates override result and strips its URLs from other results', () => {
    const results = [
      makeResult('Radiohead', [
        { sourceId: 'bandcamp', url: 'https://radiohead.bandcamp.com' },
      ]),
      makeResult('Radiohead', [
        { sourceId: 'qobuz', url: 'https://www.qobuz.com/us-en/interpreter/radiohead/456' },
      ], { id: '-qobuz' }),
      makeResult('Radiohead', [
        { sourceId: 'mirlo', url: 'https://mirlo.space/radiohead' },
      ], { id: '-mirlo' }),
    ];

    const overrides = [makeOverride('Radiohead', [
      'https://radiohead.bandcamp.com',
      'https://www.qobuz.com/us-en/interpreter/radiohead/456',
    ])];

    applyMergeOverrides(results, overrides);

    // Override result is first, with its URLs + search-only links
    expect(results[0].name).toBe('Radiohead');
    expect(results[0].overrideMerged).toBe(true);
    expect(results[0].platforms.map(p => p.sourceId)).toContain('bandcamp');
    expect(results[0].platforms.map(p => p.sourceId)).toContain('qobuz');
    // Original results with those URLs were emptied and removed;
    // mirlo result (not in override) survives
    expect(results).toHaveLength(2);
    expect(results[1].platforms[0].sourceId).toBe('mirlo');
  });
});
