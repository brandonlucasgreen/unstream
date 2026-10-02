import { describe, it, expect, vi, afterEach } from 'vitest';

// The MusicBrainz enrichment both search phases share. Three things it must keep doing:
//
//   1. One MusicBrainz lookup after the search, not two. Release groups ride along with the
//      url-rels lookup (`inc=url-rels+release-groups`); the separate release-group request
//      cost a second request plus a second 1.1s rate-limit gap on every uncached search.
//   2. A Phase 1 that is told not to wait reads the cache and never fetches. On a miss the
//      chain would be abandoned when Phase 1 returns, and would compete with Phase 2's own
//      requests for MusicBrainz's rate limit.
//   3. Phase 2's response keeps its old shape, since shipped Mac and extension builds parse it.

// No Redis: the cache layer no-ops, so every call exercises the real fetch path.
vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

import {
  getMusicBrainzEnrichment,
  peekMusicBrainzEnrichment,
  musicBrainzEnrichmentCacheKey,
  toMusicBrainzResponse,
  type EnrichedMusicBrainzResult,
} from '../musicbrainz-enrichment';

const MBID = '11111111-2222-3333-4444-555555555555';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// MusicBrainz answers; every other host (Discogs, Wikipedia, PeerTube, Mirlo...) 404s, which
// each helper treats as "nothing there".
function mockMusicBrainz(releaseDates: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/?query=')) {
      return json({ artists: [{ id: MBID, name: 'Test Artist', score: 100 }] });
    }
    if (url.startsWith(`https://musicbrainz.org/ws/2/artist/${MBID}`)) {
      return json({
        relations: [{ type: 'official homepage', url: { resource: 'https://testartist.example/' } }],
        'release-groups': releaseDates.map(d => ({ 'first-release-date': d })),
      });
    }
    return new Response('not found', { status: 404 });
  });
}

function musicBrainzCalls(fetchSpy: ReturnType<typeof mockMusicBrainz>): string[] {
  return fetchSpy.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('https://musicbrainz.org/'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMusicBrainzEnrichment', () => {
  it('makes one lookup after the search, carrying release groups with the url-rels', async () => {
    const fetchSpy = mockMusicBrainz(['2019-05-01']);

    const { data } = await getMusicBrainzEnrichment('Test Artist');

    const calls = musicBrainzCalls(fetchSpy);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('inc=url-rels+release-groups');
    expect(calls.some(u => u.includes('/release-group/'))).toBe(false);
    expect(data.artistName).toBe('Test Artist');
    expect(data.officialUrl).toBe('https://testartist.example/');
    expect(data.enrichmentComplete).toBe(true);
  });

  it('reads pre-2005 eligibility from the release groups in the lookup', async () => {
    mockMusicBrainz(['2019-05-01', '1998-03-10']);
    const { data } = await getMusicBrainzEnrichment('Test Artist');
    expect(data.hasPre2005Release).toBe(true);
  });

  it('is not library-eligible when every release group is 2005 or later', async () => {
    mockMusicBrainz(['2005-01-01', '2019-05-01', '']);
    const { data } = await getMusicBrainzEnrichment('Test Artist');
    expect(data.hasPre2005Release).toBe(false);
  });
});

describe('peekMusicBrainzEnrichment', () => {
  it('returns the cached enrichment without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const entry = { artistName: 'Test Artist' } as EnrichedMusicBrainzResult;
    const prefetched = Promise.resolve(new Map([[musicBrainzEnrichmentCacheKey('test artist'), entry]]));

    expect(await peekMusicBrainzEnrichment('test artist', prefetched)).toBe(entry);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a miss, still without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await peekMusicBrainzEnrichment('test artist', Promise.resolve(new Map()))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function enrichment(overrides: Partial<EnrichedMusicBrainzResult> = {}): EnrichedMusicBrainzResult {
  return {
    query: 'test artist',
    artistName: 'Test Artist',
    officialUrl: null,
    discogsUrl: null,
    bandcampUrl: null,
    bandcampSubdomain: null,
    qobuzUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
    discoveredPlatforms: [],
    platformUrls: [],
    wikipediaSummary: null,
    wikipediaUrl: null,
    bandcampBio: null,
    discogsProfile: null,
    bioFetchFailed: false,
    location: undefined,
    suggestedNames: [],
    searchFailed: false,
    enrichmentComplete: true,
    ...overrides,
  };
}

const LONG_BIO = 'Test Artist is a four-piece band from Glasgow who have been making noisy, melodic records together since 2014.';

describe('toMusicBrainzResponse', () => {
  it('is null when MusicBrainz did not answer', () => {
    expect(toMusicBrainzResponse(enrichment({ artistName: null, searchFailed: true }))).toBeNull();
  });

  it('is a populated empty response when MusicBrainz has no such artist', () => {
    const response = toMusicBrainzResponse(enrichment({ artistName: null }));
    expect(response).not.toBeNull();
    expect(response!.artistName).toBeNull();
  });

  it('surfaces a Subvert relation as a discovered platform, as Phase 2 always has', () => {
    const response = toMusicBrainzResponse(enrichment({ platformUrls: ['https://subvert.fm/testartist'] }));
    expect(response!.discoveredPlatforms).toEqual([{ platform: 'subvert', url: 'https://subvert.fm/testartist' }]);
  });

  it('does not duplicate a Subvert link the official site already gave', () => {
    const response = toMusicBrainzResponse(enrichment({
      platformUrls: ['https://subvert.fm/testartist'],
      discoveredPlatforms: [{ platform: 'subvert', url: 'https://www.subvert.fm/testartist' }],
    }));
    expect(response!.discoveredPlatforms).toHaveLength(1);
  });

  it("prefers the artist's own Bandcamp bio over Discogs and Wikipedia", () => {
    const response = toMusicBrainzResponse(enrichment({
      bandcampUrl: 'https://testartist.bandcamp.com/',
      bandcampBio: LONG_BIO,
      discogsUrl: 'https://www.discogs.com/artist/1-Test-Artist',
      discogsProfile: `Discogs says: ${LONG_BIO}`,
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Test_Artist',
      wikipediaSummary: `Wikipedia says: ${LONG_BIO}`,
    }));
    expect(response!.bio?.source).toBe('bandcamp');
    expect(response!.bio?.sourceUrl).toBe('https://testartist.bandcamp.com/');
  });

  it('falls back to Wikipedia when it is the only bio', () => {
    const response = toMusicBrainzResponse(enrichment({
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Test_Artist',
      wikipediaSummary: LONG_BIO,
    }));
    expect(response!.bio?.source).toBe('wikipedia');
  });

  it("passes on MusicBrainz's Bandcamp account, so clients can refuse a same-name stranger", () => {
    // Kept even though the account is retired: it still says which account is theirs.
    const response = toMusicBrainzResponse(enrichment({ bandcampUrl: null, bandcampSubdomain: 'honeyyycrush' }));
    expect(response!.bandcampSubdomain).toBe('honeyyycrush');
  });

  it('tolerates cache entries written before bios existed', () => {
    const old = enrichment();
    delete (old as Partial<EnrichedMusicBrainzResult>).bandcampBio;
    delete (old as Partial<EnrichedMusicBrainzResult>).discogsProfile;
    delete (old as Partial<EnrichedMusicBrainzResult>).bioFetchFailed;
    const response = toMusicBrainzResponse(old);
    expect(response!.bio).toBeNull();
    expect(response!.bioFetchFailed).toBe(false);
  });
});
