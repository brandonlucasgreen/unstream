import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /api/search/stored lets the web client show the claimed and verified artists we already
// hold while the platform fan-out is still running. What must hold:
//
//   - The early cards are the SAME cards the full search returns for those artists — same
//     ids, same content. The client renders both lists under `key={result.id}`, so equal ids
//     mean the full results update the early cards in place. A different id would remount a
//     claimed card, and ResultCard records a search appearance on the artist's dashboard
//     each time one mounts: the artist would see every search counted twice.
//   - A database failure is "no early cards", never a failed request.

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getArtistBySlug: vi.fn(),
  getArtistsBySlugs: vi.fn(),
  findKnownArtistSlugsByName: vi.fn(),
}));

vi.mock('../db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db')>();
  return {
    ...original,
    ...dbMocks,
    persistSearchResults: vi.fn(async () => {}),
    getMergeOverrides: vi.fn(async () => []),
    getLinkSuppressions: vi.fn(async () => []),
  };
});

import { handler as storedHandler } from '../search-stored';
import { handler as searchHandler } from '../search-sources';

function dbArtist(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-id',
    slug: 'test-artist',
    name: 'Test Artist',
    type: 'artist' as const,
    imageUrl: undefined,
    platforms: [{ sourceId: 'bandcamp', url: 'https://testartist.bandcamp.com/' }],
    matchConfidence: 'verified' as const,
    profile: undefined,
    location: undefined,
    ...overrides,
  };
}

const claimed = dbArtist({
  slug: 'kid-lightbulbs',
  name: 'Kid Lightbulbs',
  matchConfidence: 'claimed',
  profile: { bio: 'Experimental and alternative rock from a bedroom near you.', showBio: true },
});
const verified = dbArtist({ slug: 'kid-lightbulbs-tribute', name: 'Kid Lightbulbs Tribute' });

beforeEach(() => {
  dbMocks.getArtistBySlug.mockResolvedValue(claimed);
  dbMocks.findKnownArtistSlugsByName.mockResolvedValue(['kid-lightbulbs', 'kid-lightbulbs-tribute']);
  dbMocks.getArtistsBySlugs.mockResolvedValue(new Map([
    ['kid-lightbulbs', claimed],
    ['kid-lightbulbs-tribute', verified],
  ]));
  // Every platform and MusicBrainz 404s, so the full search's only results are stored ones.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/api/search/stored', () => {
  it('returns the claimed profile first, then known artists, each once', async () => {
    const response = await storedHandler({ queryStringParameters: { query: 'Kid Lightbulbs' } });

    expect(response.statusCode).toBe(200);
    const { results } = JSON.parse(response.body);
    expect(results.map((r: { id: string }) => r.id)).toEqual([
      'claimed-kid-lightbulbs',
      'known-kid-lightbulbs-tribute',
    ]);
  });

  it('returns exactly the cards the full search returns for the same artists', async () => {
    const early = JSON.parse((await storedHandler({ queryStringParameters: { query: 'Kid Lightbulbs' } })).body).results;
    const fullResponse = await searchHandler({ queryStringParameters: { query: 'Kid Lightbulbs' } });
    if (!fullResponse) throw new Error('search handler returned no response');
    const full = JSON.parse(fullResponse.body).results;
    expect(full.length).toBeGreaterThan(0);

    for (const card of early) {
      expect(full.find((r: { id: string }) => r.id === card.id)).toEqual(card);
    }
  });

  it('answers with no cards when the database fails', async () => {
    dbMocks.getArtistBySlug.mockRejectedValue(new Error('connection reset'));
    dbMocks.findKnownArtistSlugsByName.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await storedHandler({ queryStringParameters: { query: 'Kid Lightbulbs' } });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).results).toEqual([]);
  });

  it('rejects a missing query', async () => {
    const response = await storedHandler({ queryStringParameters: {} });
    expect(response.statusCode).toBe(400);
  });
});
