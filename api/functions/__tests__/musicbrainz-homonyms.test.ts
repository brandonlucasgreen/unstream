import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Paracosm report (2026-10-27). MusicBrainz lists several artists named exactly
// "Paracosm", ranked: a punk band in Orlando (no Bandcamp), a hyperpop artist in Los Angeles
// (xparacosm.bandcamp.com), an untyped "digital design" entry, and a rock band in Sofia whose
// entry lists only an Instagram. The Bandcamp probe finds paracosm.bandcamp.com — the Sofia band.
//
// Enrichment used to read only MusicBrainz's top hit and merge it by name, so the one card a
// search showed was Sofia's Bandcamp with Orlando's site, socials and city, and the Los Angeles
// artist — who reported it — appeared nowhere: their account isn't derivable from the name, and
// the MusicBrainz entry that names it was never read. What must hold:
//   - the other same-name artists are recorded, and the best-ranked ones' links looked up;
//   - with the name shared, a name match is not an identity match: only the same Bandcamp
//     account merges, and every MusicBrainz artist with links gets a card of their own.

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

// The probe has its own suite; here it only needs to find the Sofia band, as it does live.
vi.mock('../../search/bandcamp-probe', () => ({
  findBandcampArtist: vi.fn(async (query: string) =>
    query.toLowerCase() === 'paracosm'
      ? { url: 'https://paracosm.bandcamp.com', bandName: 'Paracosm', releaseTitles: ['огън', 'стени'], imageUrl: null, bio: '' }
      : null),
}));

import { getMusicBrainzEnrichment, toMusicBrainzResponse } from '../musicbrainz-enrichment';
import { handler } from '../search-sources';

const ORLANDO = 'be506365-6ee7-4ad4-bbad-69fae4275b0d';
const LOS_ANGELES = '7b677a62-b858-41c9-be22-4eacf62eb30f';
const DIGITAL_DESIGN = '698d39a9-397e-4544-a404-692f3dd9108b';
const SOFIA = 'bd3b5fe9-5750-4f2a-94a7-d2d8bc691370';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockMusicBrainz({ failLookupOf }: { failLookupOf?: string } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/?query=')) {
      return json({ artists: [
        { id: ORLANDO, name: 'Paracosm', score: 100, type: 'Group', disambiguation: 'US punk band from Orlando, FL', area: { name: 'Orlando', type: 'City' } },
        { id: LOS_ANGELES, name: 'paracosm', score: 99, type: 'Person', disambiguation: 'hyperpop artist from LA', area: { name: 'Burbank', type: 'City' } },
        { id: DIGITAL_DESIGN, name: 'paracosm', score: 99, disambiguation: 'digital design' },
        { id: SOFIA, name: 'Paracosm', score: 99, type: 'Group', disambiguation: 'Bulgarian alternative rock band', area: { name: 'Bulgaria', type: 'Country', 'iso-3166-1-codes': ['BG'] } },
        { id: 'unrelated', name: 'Yung Paracosm', score: 90 },
      ] });
    }
    if (failLookupOf && url.startsWith(`https://musicbrainz.org/ws/2/artist/${failLookupOf}`)) {
      return new Response('unavailable', { status: 503 });
    }
    if (url.startsWith(`https://musicbrainz.org/ws/2/artist/${ORLANDO}`)) {
      return json({
        area: { name: 'Orlando', type: 'City' },
        relations: [
          { type: 'official homepage', url: { resource: 'https://paracosmtheband.com/' } },
          { type: 'social network', url: { resource: 'https://www.instagram.com/paracosm_theband/' } },
          { type: 'social network', url: { resource: 'https://www.tiktok.com/@paracosmband' } },
        ],
        'release-groups': [],
      });
    }
    if (url.startsWith(`https://musicbrainz.org/ws/2/artist/${LOS_ANGELES}`)) {
      return json({
        relations: [
          { type: 'bandcamp', url: { resource: 'https://xparacosm.bandcamp.com/' } },
          { type: 'official homepage', url: { resource: 'https://www.paracosm.cc/' } },
          { type: 'social network', url: { resource: 'https://www.instagram.com/paracosm.cc/' } },
          { type: 'soundcloud', url: { resource: 'https://soundcloud.com/xparacosm' } },
        ],
      });
    }
    if (url.startsWith(`https://musicbrainz.org/ws/2/artist/${DIGITAL_DESIGN}`)) {
      return json({ relations: [{ type: 'social network', url: { resource: 'https://www.instagram.com/paracosm/' } }] });
    }
    if (url.startsWith(`https://musicbrainz.org/ws/2/artist/${SOFIA}`)) {
      return json({ relations: [{ type: 'social network', url: { resource: 'https://www.instagram.com/paracosmofficial/' } }] });
    }
    if (init?.method === 'HEAD' && url.startsWith('https://xparacosm.bandcamp.com')) {
      return new Response(null, { status: 200 });
    }
    if (url === 'https://xparacosm.bandcamp.com/music') {
      return new Response('<meta property="og:image" content="https://f4.bcbits.com/img/0040943917_23.jpg">', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

function lookupsOf(fetchSpy: ReturnType<typeof mockMusicBrainz>): string[] {
  return fetchSpy.mock.calls
    .map(c => String(c[0]))
    .filter(u => u.startsWith('https://musicbrainz.org/ws/2/artist/') && !u.includes('?query='));
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('getMusicBrainzEnrichment: same-name artists', () => {
  it('records every other artist by the name and looks up the best-ranked two performers', async () => {
    const fetchSpy = mockMusicBrainz();

    const { data } = await getMusicBrainzEnrichment('Paracosm');

    expect(data.artistName).toBe('Paracosm');
    expect(data.officialUrl).toBe('https://paracosmtheband.com/');
    expect(data.homonyms.map(h => h.mbid)).toEqual([LOS_ANGELES, DIGITAL_DESIGN, SOFIA]);

    const [la, design, sofia] = data.homonyms;
    expect(la.bandcampUrl).toBe('https://xparacosm.bandcamp.com/');
    expect(la.bandcampSubdomain).toBe('xparacosm');
    expect(la.officialUrl).toBe('https://www.paracosm.cc/');
    expect(la.socialLinks.map(s => s.url)).toEqual(['https://www.instagram.com/paracosm.cc/']);
    expect(la.disambiguation).toBe('hyperpop artist from LA');
    // Read from their /music page, whose og:image is the artist photo (the bare address can
    // redirect to a release, whose og:image is cover art).
    expect(la.imageUrl).toBe('https://f4.bcbits.com/img/0040943917_23.jpg');
    expect(sofia.socialLinks.map(s => s.url)).toEqual(['https://www.instagram.com/paracosmofficial/']);
    expect(sofia.location?.country).toBe('Bulgaria');
    // Not a person or a group by MusicBrainz's account: never looked up, known only from the hit.
    expect(design.socialLinks).toEqual([]);

    expect(lookupsOf(fetchSpy)).toHaveLength(3);
    expect(lookupsOf(fetchSpy).some(u => u.startsWith(`https://musicbrainz.org/ws/2/artist/${DIGITAL_DESIGN}`))).toBe(false);
    expect(data.enrichmentComplete).toBe(true);
  }, 15000);

  it('gives no card to the matched artist when the name is shared and their lookup failed', async () => {
    mockMusicBrainz({ failLookupOf: ORLANDO });

    const response = await handler({ queryStringParameters: { query: 'Paracosm' } });
    const body = JSON.parse(response.body) as { results: { name: string; platforms: { url: string }[] }[]; hasPendingEnrichment: boolean };

    // A card saying only "Paracosm" can't be told apart from the others; the retry fills it in.
    expect(body.results.filter(r => r.name.toLowerCase() === 'paracosm')).toHaveLength(2);
    expect(body.hasPendingEnrichment).toBe(true);
  }, 20000);

  it("leaves enrichment pending when a same-name artist's Bandcamp page didn't answer", async () => {
    const fetchSpy = mockMusicBrainz();
    const answer = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, init) =>
      String(input) === 'https://xparacosm.bandcamp.com/music' ? new Response('', { status: 503 }) : answer(input, init));

    const { data } = await getMusicBrainzEnrichment('Paracosm');

    // Their link is known; their photo is unknown, not absent.
    expect(data.homonyms[0].bandcampUrl).toBe('https://xparacosm.bandcamp.com/');
    expect(data.homonyms[0].imageUrl).toBeNull();
    expect(data.enrichmentComplete).toBe(false);
  }, 15000);

  it('leaves enrichment pending when a same-name artist could not be looked up', async () => {
    mockMusicBrainz({ failLookupOf: LOS_ANGELES });

    const { data } = await getMusicBrainzEnrichment('Paracosm');

    expect(data.homonyms[0].mbid).toBe(LOS_ANGELES);
    expect(data.homonyms[0].bandcampUrl).toBeNull();
    // Unknown, not absent: the failure TTL applies, and Phase 1 says enrichment is pending.
    expect(data.enrichmentComplete).toBe(false);
  }, 15000);

  it('passes the homonyms to Phase 2, and reads an older cache entry as having none', async () => {
    mockMusicBrainz();
    const { data } = await getMusicBrainzEnrichment('Paracosm');

    expect(toMusicBrainzResponse(data)?.homonyms).toHaveLength(3);

    const older = { ...data } as Partial<typeof data>;
    delete older.homonyms;
    expect(toMusicBrainzResponse(older as typeof data)?.homonyms).toEqual([]);
  }, 15000);
});

describe('search-sources: three Paracosms', () => {
  it('shows each artist on their own card, with only their own links', async () => {
    mockMusicBrainz();

    const response = await handler({ queryStringParameters: { query: 'Paracosm' } });
    const { results } = JSON.parse(response.body) as {
      results: { id: string; name: string; platforms: { sourceId: string; url: string }[]; location?: { city?: string } }[];
    };

    const urlsOf = (r: { platforms: { url: string }[] }) => r.platforms.map(p => p.url);
    const sofia = results.find(r => urlsOf(r).includes('https://paracosm.bandcamp.com'));
    const orlando = results.find(r => urlsOf(r).includes('https://paracosmtheband.com/'));
    const losAngeles = results.find(r => urlsOf(r).includes('https://xparacosm.bandcamp.com/'));

    expect(sofia).toBeDefined();
    expect(orlando).toBeDefined();
    expect(losAngeles).toBeDefined();
    expect(new Set([sofia!.id, orlando!.id, losAngeles!.id]).size).toBe(3);

    // Sofia's card carries nothing of Orlando's: not their site, not their socials, not their city.
    expect(urlsOf(sofia!)).not.toContain('https://www.tiktok.com/@paracosmband');
    expect(urlsOf(sofia!)).not.toContain('https://paracosmtheband.com/');
    expect(sofia!.location?.city).not.toBe('Orlando');

    expect(urlsOf(orlando!)).toContain('https://www.tiktok.com/@paracosmband');
    expect(urlsOf(orlando!).some(u => u.includes('bandcamp.com'))).toBe(false);
    expect(urlsOf(losAngeles!)).toEqual(expect.arrayContaining(['https://www.paracosm.cc/', 'https://www.instagram.com/paracosm.cc/']));
    // MusicBrainz has no photos; this one is from the Bandcamp page the card links.
    expect((losAngeles as { imageUrl?: string }).imageUrl).toBe('https://f4.bcbits.com/img/0040943917_23.jpg');
    // Orlando has no Bandcamp, so no photo — none is borrowed from anyone else.
    expect((orlando as { imageUrl?: string }).imageUrl).toBeUndefined();

    // Sofia's MusicBrainz entry, with only an Instagram, doesn't become a second Sofia card, and
    // the "digital design" entry only marked the name as shared.
    expect(results.filter(r => r.name.toLowerCase() === 'paracosm')).toHaveLength(3);
    expect(results.flatMap(urlsOf)).not.toContain('https://www.instagram.com/paracosmofficial/');
  }, 20000);
});
