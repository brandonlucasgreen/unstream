import { describe, it, expect } from 'vitest';
import { mergeWithMusicBrainzData } from '../../src/services/sources';
import type { SearchResult, MusicBrainzData } from '../../src/types';

// The Honeycrush report, on the client's merge path.
//
// Searching "honeycrush": the Bandcamp probe finds honeycrush.bandcamp.com, a real Orlando band
// called "Honey Crush". MusicBrainz knows the Brooklyn artist Honeycrush and lists a different
// (since retired) account, honeyyycrush. The names normalize identically, so a name-only merge
// grafted Brooklyn's location, Instagram and Wikipedia entry onto the Orlando card.
//
// The server has refused that merge since July (applyEnrichmentToResults). Deferring
// MusicBrainz to Phase 2 put every first search through this client-side merge instead, which
// had no such check — so the bug came back on the web. What must hold here, as on the server:
//   - a result on a different Bandcamp subdomain than MusicBrainz lists is left alone;
//   - the MusicBrainz artist gets a card of their own instead of disappearing.

function honeyCrushOrlando(): SearchResult {
  return {
    id: 'honeycrush',
    name: 'Honey Crush',
    type: 'artist',
    platforms: [{ sourceId: 'bandcamp', url: 'https://honeycrush.bandcamp.com/' }],
    matchConfidence: 'verified',
    location: { city: 'Orlando', region: 'Florida', country: 'United States', countryCode: 'US' },
  };
}

function honeycrushBrooklyn(overrides: Partial<MusicBrainzData> = {}): MusicBrainzData {
  return {
    query: 'honeycrush',
    artistName: 'Honeycrush',
    officialUrl: 'https://honeycrushmusic.com/',
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [{ platform: 'instagram', url: 'https://www.instagram.com/honeycrushband/' }],
    // The retired honeyyycrush URL was already dropped from platformUrls by Phase 2.
    platformUrls: [],
    location: { city: 'Brooklyn', region: 'New York', country: 'United States', countryCode: 'US' },
    bandcampSubdomain: 'honeyyycrush',
    ...overrides,
  };
}

describe('mergeWithMusicBrainzData: same name, different Bandcamp account', () => {
  it("leaves the Orlando band's card exactly as it was", () => {
    const orlando = honeyCrushOrlando();
    const merged = mergeWithMusicBrainzData([orlando], honeycrushBrooklyn());

    expect(merged[0]).toEqual(orlando);
  });

  it('gives the Brooklyn artist a card of their own with their own links', () => {
    const merged = mergeWithMusicBrainzData([honeyCrushOrlando()], honeycrushBrooklyn());

    expect(merged).toHaveLength(2);
    const brooklyn = merged[1];
    expect(brooklyn.name).toBe('Honeycrush');
    expect(brooklyn.location?.city).toBe('Brooklyn');
    expect(brooklyn.platforms.map(p => p.url)).toEqual(expect.arrayContaining([
      'https://honeycrushmusic.com/',
      'https://www.instagram.com/honeycrushband/',
    ]));
    // No Bandcamp link at all: MusicBrainz's account is retired, and the probe's is someone else's.
    expect(brooklyn.platforms.some(p => p.sourceId === 'bandcamp')).toBe(false);
  });

  it("links the artist's own Bandcamp on their card when MusicBrainz's account is live", () => {
    const merged = mergeWithMusicBrainzData([honeyCrushOrlando()], honeycrushBrooklyn({
      bandcampSubdomain: 'honeycrushbk',
      platformUrls: ['https://honeycrushbk.bandcamp.com/'],
    }));

    expect(merged[1].platforms[0]).toEqual({ sourceId: 'bandcamp', url: 'https://honeycrushbk.bandcamp.com/' });
  });

  it('still merges into a result on the same Bandcamp account', () => {
    const sameAccount: SearchResult = {
      ...honeyCrushOrlando(),
      name: 'Honeycrush',
      platforms: [{ sourceId: 'bandcamp', url: 'https://honeyyycrush.bandcamp.com/' }],
      location: undefined,
    };
    const merged = mergeWithMusicBrainzData([sameAccount], honeycrushBrooklyn());

    expect(merged).toHaveLength(1);
    expect(merged[0].location?.city).toBe('Brooklyn');
    expect(merged[0].platforms.some(p => p.sourceId === 'officialsite')).toBe(true);
  });

  it('merges as before when MusicBrainz lists no Bandcamp account — absence is not a conflict', () => {
    const merged = mergeWithMusicBrainzData([honeyCrushOrlando()], honeycrushBrooklyn({ bandcampSubdomain: null }));

    expect(merged).toHaveLength(1);
    expect(merged[0].platforms.some(p => p.sourceId === 'officialsite')).toBe(true);
  });
});
