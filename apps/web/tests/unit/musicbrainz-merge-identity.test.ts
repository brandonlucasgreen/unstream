import { describe, it, expect } from 'vitest';
import { mergeWithMusicBrainzData } from '../../src/services/sources';
import type { SearchResult, MusicBrainzData, MusicBrainzHomonym } from '../../src/types';

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

// Paracosm: MusicBrainz ranks an Orlando punk band (no Bandcamp) first and also lists a Los Angeles
// hyperpop artist (xparacosm) and an entry with no links; the probe found the Sofia band's
// paracosm.bandcamp.com. Phase 2 on the web is where a deferred search meets this.
describe('mergeWithMusicBrainzData: several artists by one name', () => {
  function sofia(): SearchResult {
    return {
      id: 'paracosm',
      name: 'Paracosm',
      type: 'artist',
      platforms: [{ sourceId: 'bandcamp', url: 'https://paracosm.bandcamp.com' }],
      matchConfidence: 'verified',
    };
  }

  const losAngeles: MusicBrainzHomonym = {
    mbid: '7b677a62-b858-41c9-be22-4eacf62eb30f',
    name: 'paracosm',
    disambiguation: 'hyperpop artist from LA',
    officialUrl: 'https://www.paracosm.cc/',
    bandcampUrl: 'https://xparacosm.bandcamp.com/',
    bandcampSubdomain: 'xparacosm',
    socialLinks: [{ platform: 'instagram', url: 'https://www.instagram.com/paracosm.cc/' }],
    platformUrls: ['https://xparacosm.bandcamp.com/'],
    location: { city: 'Burbank' },
  };
  const noLinks: MusicBrainzHomonym = {
    mbid: '698d39a9-397e-4544-a404-692f3dd9108b',
    name: 'paracosm',
    disambiguation: 'digital design',
    officialUrl: null,
    bandcampUrl: null,
    bandcampSubdomain: null,
    socialLinks: [],
    platformUrls: [],
  };

  const orlando: MusicBrainzData = {
    query: 'paracosm',
    artistName: 'Paracosm',
    officialUrl: 'https://paracosmtheband.com/',
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [{ platform: 'tiktok', url: 'https://www.tiktok.com/@paracosmband' }],
    platformUrls: [],
    location: { city: 'Orlando', country: 'United States', countryCode: 'US' },
    bandcampSubdomain: null,
    homonyms: [losAngeles, noLinks],
  };

  it("leaves the Sofia band's card exactly as it was", () => {
    const card = sofia();
    expect(mergeWithMusicBrainzData([card], orlando)[0]).toEqual(card);
  });

  it('gives Orlando and Los Angeles cards of their own, and none to the entry with no links', () => {
    const merged = mergeWithMusicBrainzData([sofia()], orlando);

    expect(merged).toHaveLength(3);
    expect(new Set(merged.map(r => r.id)).size).toBe(3);
    expect(merged[1].location?.city).toBe('Orlando');
    expect(merged[1].platforms.map(p => p.url)).toContain('https://www.tiktok.com/@paracosmband');
    expect(merged[2].platforms[0]).toEqual({ sourceId: 'bandcamp', url: 'https://xparacosm.bandcamp.com/' });
    expect(merged[2].platforms.map(p => p.url)).toContain('https://www.paracosm.cc/');
  });

  it('merges a homonym into the card on their own Bandcamp account', () => {
    const laCard: SearchResult = { ...sofia(), id: 'xparacosm', platforms: [{ sourceId: 'bandcamp', url: 'https://xparacosm.bandcamp.com' }] };
    const merged = mergeWithMusicBrainzData([sofia(), laCard], orlando);

    expect(merged).toHaveLength(3);
    expect(merged[1].platforms.map(p => p.url)).toContain('https://www.paracosm.cc/');
  });
});
