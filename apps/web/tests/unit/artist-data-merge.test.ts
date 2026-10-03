import { describe, it, expect } from 'vitest';

// The merge generate-artist-data.ts uses to fold MusicBrainz data into search results before
// writing data/artists/*.json, the files behind the published artist pages.
import {
  mergeWithMusicBrainzData,
  type MusicBrainzData,
  type SearchResult,
} from '../../../../scripts/artist-data-merge';

function artist(id: string, name: string, bandcampUrl?: string): SearchResult {
  return {
    id,
    name,
    type: 'artist',
    platforms: bandcampUrl ? [{ sourceId: 'bandcamp', url: bandcampUrl }] : [],
  };
}

function mb(overrides: Partial<MusicBrainzData> = {}): MusicBrainzData {
  return {
    query: 'Honeycrush',
    artistName: 'Honeycrush',
    officialUrl: 'https://honeycrush.example',
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/honeycrushband' }],
    bandcampSubdomain: 'honeycrush-online',
    ...overrides,
  };
}

const sourceIds = (r: SearchResult) => r.platforms.map(p => p.sourceId);

describe('mergeWithMusicBrainzData (generate-artist-data)', () => {
  it('keeps a same-name artist on a different Bandcamp account separate', () => {
    // Honeycrush (Brooklyn) is honeycrush-online on Bandcamp; Honey Crush (Orlando) owns
    // honeycrush.bandcamp.com. MusicBrainz's links belong to Brooklyn only.
    const orlando = artist('orlando', 'Honey Crush', 'https://honeycrush.bandcamp.com');
    const brooklyn = artist('brooklyn', 'Honeycrush', 'https://honeycrush-online.bandcamp.com');

    const [mergedOrlando, mergedBrooklyn] = mergeWithMusicBrainzData([orlando, brooklyn], mb());

    expect(mergedOrlando).toEqual(orlando);
    expect(sourceIds(mergedBrooklyn)).toEqual(['bandcamp', 'officialsite', 'instagram']);
  });

  it('merges when the Bandcamp subdomain is the one MusicBrainz names', () => {
    const result = artist('a', 'Honeycrush', 'https://HoneyCrush-Online.bandcamp.com/music');

    const [merged] = mergeWithMusicBrainzData([result], mb());

    expect(merged.platforms).toContainEqual({ sourceId: 'officialsite', url: 'https://honeycrush.example' });
  });

  it('merges when the result has no Bandcamp link', () => {
    const [merged] = mergeWithMusicBrainzData([artist('a', 'Honeycrush')], mb());

    expect(sourceIds(merged)).toEqual(['officialsite', 'instagram']);
  });

  it('merges when MusicBrainz names no Bandcamp account', () => {
    const result = artist('a', 'Honeycrush', 'https://honeycrush.bandcamp.com');

    const [merged] = mergeWithMusicBrainzData([result], mb({ bandcampSubdomain: null }));

    expect(sourceIds(merged)).toEqual(['bandcamp', 'officialsite', 'instagram']);
  });

  it('matches names the way the web client does', () => {
    const results = [
      artist('close', 'National'),
      artist('longer', 'The National Parks Service Band'),
    ];

    const [close, longer] = mergeWithMusicBrainzData(
      results,
      mb({ artistName: 'The National', bandcampSubdomain: null }),
    );

    // "national" is most of "thenational", so it's the same artist written differently...
    expect(sourceIds(close)).toContain('officialsite');
    // ...but a much longer name that merely contains it is someone else.
    expect(longer).toEqual(results[1]);
  });
});
