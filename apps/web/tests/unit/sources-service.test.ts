import { describe, it, expect } from 'vitest';
import {
  parseMultiArtistQuery,
  normalizeForComparison,
  textMatchScore,
  mergeSearchResponses,
  mergeWithMusicBrainzData,
  buildMusicBrainzFallbackResult,
} from '../../src/services/sources';
import type { SearchResponse, SearchResult, MusicBrainzData } from '../../src/types';

// ---------------------------------------------------------------------------
// parseMultiArtistQuery
// ---------------------------------------------------------------------------

describe('parseMultiArtistQuery', () => {
  it('returns single-element array for simple queries', () => {
    expect(parseMultiArtistQuery('Radiohead')).toEqual(['Radiohead']);
    expect(parseMultiArtistQuery('The Black Keys')).toEqual(['The Black Keys']);
  });

  it('splits on "and"', () => {
    expect(parseMultiArtistQuery('Mo-Rice and Babebee')).toEqual(['Mo-Rice', 'Babebee']);
  });

  it('splits on "&"', () => {
    expect(parseMultiArtistQuery('Mo-Rice & Babebee')).toEqual(['Mo-Rice', 'Babebee']);
  });

  it('splits on "feat."', () => {
    expect(parseMultiArtistQuery('Kid Lightbulbs feat. ilyBBY')).toEqual(['Kid Lightbulbs', 'ilyBBY']);
  });

  it('splits on "feat" (without dot)', () => {
    expect(parseMultiArtistQuery('Kid Lightbulbs feat ilyBBY')).toEqual(['Kid Lightbulbs', 'ilyBBY']);
  });

  it('splits on "featuring"', () => {
    expect(parseMultiArtistQuery('Artist featuring Guest')).toEqual(['Artist', 'Guest']);
  });

  it('splits on comma with spaces on both sides', () => {
    expect(parseMultiArtistQuery('Artist1 , Artist2')).toEqual(['Artist1', 'Artist2']);
  });

  it('does NOT split on comma without leading space', () => {
    // The regex requires whitespace on both sides of the separator
    expect(parseMultiArtistQuery('Artist1, Artist2')).toEqual(['Artist1, Artist2']);
  });

  it('splits on "+"', () => {
    expect(parseMultiArtistQuery('Artist1 + Artist2')).toEqual(['Artist1', 'Artist2']);
  });

  it('splits on " x " (with spaces)', () => {
    expect(parseMultiArtistQuery('Kid Lightbulbs x ilyBBY')).toEqual(['Kid Lightbulbs', 'ilyBBY']);
  });

  it('does NOT split "The xx" (x without surrounding spaces in name)', () => {
    // "The xx" has no space before x, so the separator pattern won't match
    expect(parseMultiArtistQuery('The xx')).toEqual(['The xx']);
  });

  it('handles multiple separators', () => {
    const result = parseMultiArtistQuery('A and B feat. C');
    expect(result).toEqual(['A', 'B', 'C']);
  });

  it('trims whitespace from parts', () => {
    const result = parseMultiArtistQuery('  Artist1  &  Artist2  ');
    expect(result[0]).toBe('Artist1');
    expect(result[1]).toBe('Artist2');
  });

  it('filters out empty parts', () => {
    // A query that would produce empty parts after splitting
    expect(parseMultiArtistQuery('Artist')).toEqual(['Artist']);
  });
});

// ---------------------------------------------------------------------------
// normalizeForComparison (sources.ts version)
// ---------------------------------------------------------------------------

describe('sources normalizeForComparison', () => {
  it('lowercases and strips non-alphanumeric', () => {
    expect(normalizeForComparison('Kid Lightbulbs!')).toBe('kidlightbulbs');
    expect(normalizeForComparison('Matt Young')).toBe('mattyoung');
  });

  it('handles empty string', () => {
    expect(normalizeForComparison('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// textMatchScore (sources.ts version)
// ---------------------------------------------------------------------------

describe('sources textMatchScore', () => {
  it('returns 3 for exact normalized match', () => {
    expect(textMatchScore('Kid Lightbulbs', 'kidlightbulbs')).toBe(3);
  });

  it('returns 2 for starts-with match', () => {
    expect(textMatchScore('Kid Lightbulbs Music', 'kidlightbulbs')).toBe(2);
  });

  it('returns 1 for contains match', () => {
    expect(textMatchScore('The Kid Lightbulbs', 'kidlightbulbs')).toBe(1);
  });

  it('returns 0 for no match', () => {
    expect(textMatchScore('Radiohead', 'kidlightbulbs')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeSearchResponses
// ---------------------------------------------------------------------------

function makeSearchResponse(query: string, results: SearchResult[]): SearchResponse {
  return { query, results };
}

function makeResult(name: string, platforms: SearchResult['platforms'], opts: Partial<SearchResult> = {}): SearchResult {
  return {
    id: name.toLowerCase().replace(/\s/g, ''),
    name,
    type: 'artist',
    platforms,
    ...opts,
  };
}

describe('mergeSearchResponses', () => {
  it('deduplicates results by normalized name', () => {
    const r1: SearchResponse = makeSearchResponse('test', [
      makeResult('Kid Lightbulbs', [{ sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' }]),
    ]);
    const r2: SearchResponse = makeSearchResponse('test', [
      makeResult('Kid Lightbulbs', [{ sourceId: 'mirlo', url: 'https://mirlo.space/kidlightbulbs' }]),
    ]);

    const merged = mergeSearchResponses([r1, r2], 'Kid Lightbulbs');

    expect(merged.results).toHaveLength(1);
    expect(merged.results[0].platforms).toHaveLength(2);
    expect(merged.results[0].platforms.map(p => p.sourceId)).toContain('bandcamp');
    expect(merged.results[0].platforms.map(p => p.sourceId)).toContain('mirlo');
  });

  it('does not duplicate platforms with the same sourceId', () => {
    const r1: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }]),
    ]);
    const r2: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }]),
    ]);

    const merged = mergeSearchResponses([r1, r2], 'Artist');
    expect(merged.results[0].platforms).toHaveLength(1);
  });

  it('inherits imageUrl from first result that has one', () => {
    const r1: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }]),
    ]);
    const r2: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'mirlo', url: 'https://mirlo.space/a' }], { imageUrl: 'https://img.com/photo.jpg' }),
    ]);

    const merged = mergeSearchResponses([r1, r2], 'Artist');
    expect(merged.results[0].imageUrl).toBe('https://img.com/photo.jpg');
  });

  it('upgrades matchConfidence to verified when any duplicate is verified', () => {
    const r1: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }], { matchConfidence: 'unverified' }),
    ]);
    const r2: SearchResponse = makeSearchResponse('test', [
      makeResult('Artist', [{ sourceId: 'mirlo', url: 'https://mirlo.space/a' }], { matchConfidence: 'verified' }),
    ]);

    const merged = mergeSearchResponses([r1, r2], 'Artist');
    expect(merged.results[0].matchConfidence).toBe('verified');
  });

  it('sorts by text match score first, then platform count', () => {
    const r1: SearchResponse = makeSearchResponse('test', [
      makeResult('Other Band', [
        { sourceId: 'bandcamp', url: 'https://other.bandcamp.com' },
        { sourceId: 'mirlo', url: 'https://mirlo.space/other' },
        { sourceId: 'qobuz', url: 'https://qobuz.com/other' },
      ]),
      makeResult('Test', [{ sourceId: 'bandcamp', url: 'https://test.bandcamp.com' }]),
    ]);

    const merged = mergeSearchResponses([r1], 'Test');
    // 'Test' should be first despite fewer platforms because of exact name match
    expect(merged.results[0].name).toBe('Test');
  });

  it('preserves the original query in the response', () => {
    const r1: SearchResponse = makeSearchResponse('test', []);
    const merged = mergeSearchResponses([r1], 'Original Query');
    expect(merged.query).toBe('Original Query');
  });

  it('handles empty responses', () => {
    const merged = mergeSearchResponses([], 'test');
    expect(merged.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeWithMusicBrainzData
// ---------------------------------------------------------------------------

function makeMBData(overrides: Partial<MusicBrainzData> = {}): MusicBrainzData {
  return {
    query: 'test',
    artistName: 'Test Artist',
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
    ...overrides,
  };
}

function makeArtistResult(name: string, platforms: SearchResult['platforms'] = []): SearchResult {
  return {
    id: name.toLowerCase(),
    name,
    type: 'artist',
    platforms: [...platforms],
  };
}

describe('mergeWithMusicBrainzData', () => {
  it('returns results unchanged if artistName is null', () => {
    const results = [makeArtistResult('Test')];
    const mbData = makeMBData({ artistName: null });
    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged).toEqual(results);
  });

  it('does not modify non-artist results', () => {
    const results: SearchResult[] = [{
      id: 'album1',
      name: 'Test Artist',
      type: 'album',
      platforms: [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com/album/x' }],
    }];
    const mbData = makeMBData({ officialUrl: 'https://example.com' });
    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].platforms).toHaveLength(1);
  });

  // A MusicBrainz identity match is verification in its own right. Nine Inch Nails
  // was labelled "Unverified" while showing its real official site, Discogs, Qobuz
  // and socials — every one of them sourced from the MB record doing the labelling.
  it('upgrades an unverified result MusicBrainz identified to verified', () => {
    const results = [{
      ...makeArtistResult('Test Artist', [{ sourceId: 'bandcamp' as const, url: 'https://a.bandcamp.com' }]),
      matchConfidence: 'unverified' as const,
      unverifiedReason: 'no-release-data' as const,
    }];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].matchConfidence).toBe('verified');
    expect(merged[0].unverifiedReason).toBeUndefined();
  });

  it('leaves confidence alone when MusicBrainz only confirmed the name', () => {
    const results = [{
      ...makeArtistResult('Test Artist', [{ sourceId: 'bandcamp' as const, url: 'https://a.bandcamp.com' }]),
      matchConfidence: 'unverified' as const,
      unverifiedReason: 'no-release-data' as const,
    }];

    const merged = mergeWithMusicBrainzData(results, makeMBData());
    expect(merged[0].matchConfidence).toBe('unverified');
  });

  it('keeps a conflicting-releases split unverified even when MusicBrainz matches', () => {
    // That split came from comparing actual release titles. A name-level MB match
    // is weaker evidence and must not quietly erase it.
    const results = [{
      ...makeArtistResult('Test Artist', [{ sourceId: 'bandcamp' as const, url: 'https://impostor.bandcamp.com' }]),
      matchConfidence: 'unverified' as const,
      unverifiedReason: 'conflicting-releases' as const,
    }];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].matchConfidence).toBe('unverified');
    expect(merged[0].unverifiedReason).toBe('conflicting-releases');
  });

  it('does not downgrade a claimed profile', () => {
    const results = [{
      ...makeArtistResult('Test Artist', [{ sourceId: 'bandcamp' as const, url: 'https://a.bandcamp.com' }]),
      matchConfidence: 'claimed' as const,
    }];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    expect(mergeWithMusicBrainzData(results, mbData)[0].matchConfidence).toBe('claimed');
  });

  it('adds official site when available', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const official = merged[0].platforms.find(p => p.sourceId === 'officialsite');
    expect(official).toBeDefined();
    expect(official!.url).toBe('https://testartist.com');
  });

  it('adds Discogs URL when available', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({ discogsUrl: 'https://www.discogs.com/artist/12345' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const discogs = merged[0].platforms.find(p => p.sourceId === 'discogs');
    expect(discogs).toBeDefined();
    expect(discogs!.url).toBe('https://www.discogs.com/artist/12345');
  });

  it('does not add duplicate officialsite', () => {
    const results = [makeArtistResult('Test Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com' },
      { sourceId: 'officialsite', url: 'https://existing.com' },
    ])];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const officials = merged[0].platforms.filter(p => p.sourceId === 'officialsite');
    expect(officials).toHaveLength(1);
    expect(officials[0].url).toBe('https://existing.com');
  });

  it('adds hoopla and freegal for artists with pre-2005 releases', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({ hasPre2005Release: true });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].platforms.find(p => p.sourceId === 'hoopla')).toBeDefined();
    expect(merged[0].platforms.find(p => p.sourceId === 'freegal')).toBeDefined();
  });

  it('does not add hoopla/freegal for post-2005 artists', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({ hasPre2005Release: false });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].platforms.find(p => p.sourceId === 'hoopla')).toBeUndefined();
    expect(merged[0].platforms.find(p => p.sourceId === 'freegal')).toBeUndefined();
  });

  it('adds social links', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({
      socialLinks: [
        { platform: 'instagram', url: 'https://instagram.com/testartist' },
        { platform: 'youtube', url: 'https://youtube.com/@testartist' },
      ],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].platforms.find(p => p.sourceId === 'instagram')).toBeDefined();
    expect(merged[0].platforms.find(p => p.sourceId === 'youtube')).toBeDefined();
  });

  it('replaces search URLs with direct social links', () => {
    const results = [makeArtistResult('Test Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com' },
      { sourceId: 'kofi', url: 'https://duckduckgo.com/?q=site:ko-fi.com+test' },
    ])];
    const mbData = makeMBData({
      socialLinks: [
        { platform: 'kofi', url: 'https://ko-fi.com/testartist' },
      ],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const kofi = merged[0].platforms.find(p => p.sourceId === 'kofi');
    expect(kofi!.url).toBe('https://ko-fi.com/testartist');
  });

  it('does not replace direct URLs with social links', () => {
    const results = [makeArtistResult('Test Artist', [
      { sourceId: 'bandcamp', url: 'https://a.bandcamp.com' },
      { sourceId: 'instagram', url: 'https://instagram.com/official' },
    ])];
    const mbData = makeMBData({
      socialLinks: [
        { platform: 'instagram', url: 'https://instagram.com/different' },
      ],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const instagram = merged[0].platforms.find(p => p.sourceId === 'instagram');
    // Should keep existing direct URL, not replace with MB link
    expect(instagram!.url).toBe('https://instagram.com/official');
  });

  it('sorts platforms: marketplace first, search-only middle, official/library, social last', () => {
    const results = [makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }])];
    const mbData = makeMBData({
      officialUrl: 'https://testartist.com',
      discogsUrl: 'https://discogs.com/artist/123',
      hasPre2005Release: true,
      socialLinks: [
        { platform: 'instagram', url: 'https://instagram.com/testartist' },
        { platform: 'youtube', url: 'https://youtube.com/@testartist' },
      ],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);
    const platformIds = merged[0].platforms.map(p => p.sourceId);

    // Social platforms should be at the end
    const instagramIdx = platformIds.indexOf('instagram');
    const youtubeIdx = platformIds.indexOf('youtube');
    const bandcampIdx = platformIds.indexOf('bandcamp');
    expect(instagramIdx).toBeGreaterThan(bandcampIdx);
    expect(youtubeIdx).toBeGreaterThan(bandcampIdx);

    // Official/library platforms should be before social
    const officialIdx = platformIds.indexOf('officialsite');
    expect(officialIdx).toBeLessThan(instagramIdx);
  });

  it('only modifies results that match the MusicBrainz artist name', () => {
    const results = [
      makeArtistResult('Test Artist', [{ sourceId: 'bandcamp', url: 'https://a.bandcamp.com' }]),
      makeArtistResult('Other Artist', [{ sourceId: 'bandcamp', url: 'https://b.bandcamp.com' }]),
    ];
    const mbData = makeMBData({ officialUrl: 'https://testartist.com' });

    const merged = mergeWithMusicBrainzData(results, mbData);
    expect(merged[0].platforms.find(p => p.sourceId === 'officialsite')).toBeDefined();
    expect(merged[1].platforms.find(p => p.sourceId === 'officialsite')).toBeUndefined();
  });

  it('only enriches the result whose platform URL matches MusicBrainz relation URLs', () => {
    const results = [
      makeArtistResult('Sockpuppet', [
        { sourceId: 'bandcamp', url: 'https://sockpuppet.bandcamp.com' },
        { sourceId: 'qobuz', url: 'https://qobuz.com/sockpuppet' },
      ]),
      makeArtistResult('Sockpuppet', [
        { sourceId: 'bandcamp', url: 'https://sockpuppet-il.bandcamp.com' },
      ]),
    ];
    const mbData = makeMBData({
      artistName: 'Sockpuppet',
      officialUrl: 'https://sockpuppet.com',
      socialLinks: [
        { platform: 'kofi', url: 'https://ko-fi.com/fluffy' },
        { platform: 'patreon', url: 'https://patreon.com/fluffy' },
      ],
      // MusicBrainz knows this artist's Bandcamp URL
      platformUrls: ['https://sockpuppet.bandcamp.com'],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);

    // First result's bandcamp URL matches the MB platform URL → gets enrichment
    expect(merged[0].platforms.find(p => p.sourceId === 'officialsite')).toBeDefined();
    expect(merged[0].platforms.find(p => p.sourceId === 'kofi')?.url).toBe('https://ko-fi.com/fluffy');
    expect(merged[0].platforms.find(p => p.sourceId === 'patreon')?.url).toBe('https://patreon.com/fluffy');

    // Second result has a different bandcamp URL → no enrichment
    expect(merged[1].platforms.find(p => p.sourceId === 'officialsite')).toBeUndefined();
    expect(merged[1].platforms.find(p => p.sourceId === 'patreon')).toBeUndefined();
  });

  it('falls back to heuristic scoring when no platformUrls are available', () => {
    const results = [
      makeArtistResult('Sockpuppet', [
        { sourceId: 'bandcamp', url: 'https://sockpuppet.bandcamp.com' },
        { sourceId: 'qobuz', url: 'https://qobuz.com/sockpuppet' },
      ]),
      makeArtistResult('Sockpuppet', [
        { sourceId: 'bandcamp', url: 'https://sockpuppet-il.bandcamp.com' },
      ]),
    ];
    const mbData = makeMBData({
      artistName: 'Sockpuppet',
      officialUrl: 'https://sockpuppet.com',
      socialLinks: [
        { platform: 'kofi', url: 'https://ko-fi.com/fluffy' },
      ],
      // No platformUrls — falls back to scoring heuristic
    });

    const merged = mergeWithMusicBrainzData(results, mbData);

    // First result has more platforms, wins the heuristic
    expect(merged[0].platforms.find(p => p.sourceId === 'officialsite')).toBeDefined();
    expect(merged[0].platforms.find(p => p.sourceId === 'kofi')?.url).toBe('https://ko-fi.com/fluffy');
    // Second result should NOT get enrichment
    expect(merged[1].platforms.find(p => p.sourceId === 'kofi')).toBeUndefined();
  });

  // MusicBrainz relations are the only source of Qobuz links now that the dedicated
  // Qobuz search is retired. See docs/specs/qobuz-coverage-research.md.
  it('attaches a Qobuz link from MusicBrainz relations', () => {
    const results = [makeArtistResult('Radiohead', [
      { sourceId: 'bandcamp', url: 'https://radiohead.bandcamp.com' },
    ])];
    const mbData = makeMBData({
      artistName: 'Radiohead',
      platformUrls: [
        'https://radiohead.bandcamp.com',
        'https://open.qobuz.com/artist/43840',
        'https://www.qobuz.com/us-en/interpreter/radiohead/43840',
      ],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);

    expect(merged[0].platforms.find(p => p.sourceId === 'qobuz')?.url)
      .toBe('https://www.qobuz.com/us-en/interpreter/radiohead/43840');
  });

  it('does not overwrite a Qobuz link the result already has', () => {
    const results = [makeArtistResult('Radiohead', [
      { sourceId: 'bandcamp', url: 'https://radiohead.bandcamp.com' },
      { sourceId: 'qobuz', url: 'https://www.qobuz.com/us-en/interpreter/radiohead/claimed' },
    ])];
    const mbData = makeMBData({
      artistName: 'Radiohead',
      platformUrls: ['https://www.qobuz.com/us-en/interpreter/radiohead/43840'],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);

    const qobuz = merged[0].platforms.filter(p => p.sourceId === 'qobuz');
    expect(qobuz).toHaveLength(1);
    expect(qobuz[0].url).toBe('https://www.qobuz.com/us-en/interpreter/radiohead/claimed');
  });

  it('adds no Qobuz platform when MusicBrainz has no Qobuz relation', () => {
    const results = [makeArtistResult('Radiohead', [
      { sourceId: 'bandcamp', url: 'https://radiohead.bandcamp.com' },
    ])];
    const mbData = makeMBData({
      artistName: 'Radiohead',
      platformUrls: ['https://radiohead.bandcamp.com'],
    });

    const merged = mergeWithMusicBrainzData(results, mbData);

    expect(merged[0].platforms.find(p => p.sourceId === 'qobuz')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMusicBrainzFallbackResult
// ---------------------------------------------------------------------------

describe('buildMusicBrainzFallbackResult', () => {
  const mbData: MusicBrainzData = {
    query: 'radiohead',
    artistName: 'Radiohead',
    officialUrl: 'http://www.radiohead.com/',
    discogsUrl: 'https://www.discogs.com/artist/3840',
    hasPre2005Release: true,
    socialLinks: [
      { platform: 'instagram', url: 'https://www.instagram.com/radiohead/' },
      { platform: 'youtube', url: 'https://www.youtube.com/channel/x' },
    ],
    location: { city: 'Abingdon-on-Thames', countryCode: 'GB' },
  };

  it('builds a card with official site, discogs, socials, and search links', () => {
    const result = buildMusicBrainzFallbackResult(mbData);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Radiohead');
    expect(result!.type).toBe('artist');
    // MusicBrainz named the artist and handed over their official site, Discogs
    // and socials. Nothing is in doubt, so the card must not wear a warning — this
    // is the only result on the page and there is nothing to compare it against.
    expect(result!.matchConfidence).toBe('verified');
    expect(result!.unverifiedReason).toBeUndefined();
    const ids = result!.platforms.map(p => p.sourceId);
    expect(ids.slice(0, 4)).toEqual(['officialsite', 'discogs', 'instagram', 'youtube']);
    // No Bandcamp entry: MusicBrainz gave us no Bandcamp URL, and the card used to fill that
    // silence with `bandcamp.com/search?q=`. That placeholder claimed a presence we had not
    // found, and the backend stored it as an ordinary bandcamp link (#407).
    expect(ids).not.toContain('bandcamp');
    expect(result!.platforms.every(p => !p.url.includes('bandcamp.com/search'))).toBe(true);
    expect(result!.location?.city).toBe('Abingdon-on-Thames');
  });

  it('returns null when MusicBrainz had no match', () => {
    expect(buildMusicBrainzFallbackResult({ ...mbData, artistName: null })).toBeNull();
  });

  it('omits absent links without leaving gaps', () => {
    const bare = buildMusicBrainzFallbackResult({
      ...mbData,
      officialUrl: null,
      discogsUrl: null,
      socialLinks: [],
    });
    const ids = bare!.platforms.map(p => p.sourceId);
    // Ampwall now leads, because the Bandcamp placeholder that used to sit here is gone.
    expect(ids[0]).toBe('ampwall');
    expect(ids).not.toContain('bandcamp');
    expect(ids).not.toContain('officialsite');
  });

  it('stays unverified when MusicBrainz only confirmed the name', () => {
    // Nothing but search links: MB knows the name and nothing else, so there is
    // genuinely no destination we can vouch for.
    const bare = buildMusicBrainzFallbackResult({
      ...mbData,
      officialUrl: null,
      discogsUrl: null,
      socialLinks: [],
    });
    expect(bare!.matchConfidence).toBe('unverified');
    expect(bare!.unverifiedReason).toBe('no-release-data');
  });

  it('is verified on socials alone', () => {
    const socialsOnly = buildMusicBrainzFallbackResult({
      ...mbData,
      officialUrl: null,
      discogsUrl: null,
    });
    expect(socialsOnly!.matchConfidence).toBe('verified');
  });
});
