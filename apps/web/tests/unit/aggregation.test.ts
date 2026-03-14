import { describe, it, expect } from 'vitest';
import {
  aggregateResults,
  type PlatformResult,
  type AggregatedResult,
} from '../../../../api/functions/search-utils';

function makeBandcampResult(name: string, subdomain: string): PlatformResult {
  return {
    sourceId: 'bandcamp',
    name,
    type: 'artist',
    url: `https://${subdomain}.bandcamp.com`,
  };
}

function makeMirloResult(name: string, slug: string): PlatformResult {
  return {
    sourceId: 'mirlo',
    name,
    type: 'artist',
    url: `https://mirlo.space/${slug}`,
  };
}

describe('aggregateResults', () => {
  it('merges same-name Bandcamp + Mirlo into one result', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Kid Lightbulbs', 'kidlightbulbs'),
      makeMirloResult('Kid Lightbulbs', 'kidlightbulbs'),
    ];

    const aggregated = aggregateResults(results, 'kid lightbulbs');
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].platforms).toHaveLength(2);
    expect(aggregated[0].platforms.map(p => p.sourceId)).toContain('bandcamp');
    expect(aggregated[0].platforms.map(p => p.sourceId)).toContain('mirlo');
  });

  it('splits same-name artists on same platform with different URLs', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Matt Young', 'mattyoungmusictx'),
      makeBandcampResult('Matt Young', 'mattyoungmusic'),
    ];

    const aggregated = aggregateResults(results, 'matt young');
    expect(aggregated.length).toBeGreaterThanOrEqual(2);

    // Each should have exactly one Bandcamp platform
    const bandcampUrls = aggregated.map(
      r => r.platforms.find(p => p.sourceId === 'bandcamp')?.url
    );
    expect(bandcampUrls).toContain('https://mattyoungmusictx.bandcamp.com');
    expect(bandcampUrls).toContain('https://mattyoungmusic.bandcamp.com');
  });

  it('filters out search placeholder results', () => {
    const results: PlatformResult[] = [
      { sourceId: 'bandcamp', name: 'Search "test"', type: 'artist', url: 'https://test.bandcamp.com' },
      makeBandcampResult('Real Artist', 'realartist'),
    ];

    const aggregated = aggregateResults(results, 'test');
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].name).toBe('Real Artist');
  });

  it('sorts by text match score then platform count', () => {
    const results: PlatformResult[] = [
      makeBandcampResult('Not A Match', 'notamatch'),
      makeBandcampResult('Kid Lightbulbs', 'kidlightbulbs'),
      makeMirloResult('Kid Lightbulbs', 'kidlightbulbs'),
    ];

    const aggregated = aggregateResults(results, 'kid lightbulbs');
    expect(aggregated[0].name).toBe('Kid Lightbulbs');
  });

  it('preserves image URL from first result', () => {
    const results: PlatformResult[] = [
      { ...makeBandcampResult('Artist', 'artist'), imageUrl: 'https://img.com/photo.jpg' },
      makeMirloResult('Artist', 'artist'),
    ];

    const aggregated = aggregateResults(results, 'artist');
    expect(aggregated[0].imageUrl).toBe('https://img.com/photo.jpg');
  });
});
