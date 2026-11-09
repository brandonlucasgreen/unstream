// UC5: the zero-result capture is the coverage-gap signal (which artists fans look for that we
// can't place). What must hold for it to mean that:
//
//   - It counts what the fan actually got, stored artists included. Counting before the stored
//     merge reported searches answered from storage as gaps.
//   - An empty answer from a search where a source didn't answer is told apart from a real gap
//     (`search_complete: 'no'`, with the sources), so a MusicBrainz outage doesn't read as
//     "we don't cover this artist".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  getArtistBySlug: vi.fn(async () => null),
  getArtistsBySlugs: vi.fn(async () => new Map()),
  findKnownArtistSlugsByName: vi.fn(async () => [] as string[]),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
  withSentry: <T>(fn: T) => fn,
}));

vi.mock('../db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db')>();
  return {
    ...original,
    getArtistBySlug: mocks.getArtistBySlug,
    getArtistsBySlugs: mocks.getArtistsBySlugs,
    findKnownArtistSlugsByName: mocks.findKnownArtistSlugsByName,
    persistSearchResults: vi.fn(async () => {}),
    getMergeOverrides: vi.fn(async () => []),
    getLinkSuppressions: vi.fn(async () => []),
  };
});

vi.mock('../request-persist', () => ({ requestSearchPersist: vi.fn(async () => 'background') }));

import { handler } from '../search-sources';

const QUERY = 'Zzqx Coverage Gap';

/** Every platform 404s. MusicBrainz answers `musicBrainz` (default: a working search with no match). */
function mockFetch(musicBrainz: () => Response = () => Response.json({ artists: [] })) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://musicbrainz.org/')) return musicBrainz();
    return new Response('not found', { status: 404 });
  });
}

function zeroResultCaptures() {
  return mocks.captureMessage.mock.calls.filter(([message]) => message === 'Search returned 0 results');
}

async function search(params: Record<string, string> = {}) {
  const response = await handler({ queryStringParameters: { query: QUERY, ...params } });
  if (!response) throw new Error('search handler returned no response');
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArtistBySlug.mockResolvedValue(null);
  mocks.getArtistsBySlugs.mockResolvedValue(new Map());
  mocks.findKnownArtistSlugsByName.mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('zero-result capture', () => {
  it('reports a search every source answered and nothing matched as a complete gap', async () => {
    mockFetch();

    const response = await search();

    expect(JSON.parse(response.body).results).toEqual([]);
    const captures = zeroResultCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0][1].tags).toEqual({
      search_query: QUERY,
      search_mode: 'fuzzy',
      search_complete: 'yes',
    });
  });

  it('marks an empty answer as incomplete when MusicBrainz did not answer', async () => {
    mockFetch(() => new Response('unavailable', { status: 503 }));

    await search();

    const captures = zeroResultCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0][1].tags).toMatchObject({
      search_complete: 'no',
      incomplete_sources: 'musicbrainz',
    });
  });

  it('marks an empty answer as incomplete when MusicBrainz was left to the client', async () => {
    mockFetch();

    await search({ enrichment: 'deferred' });

    const captures = zeroResultCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0][1].tags).toMatchObject({
      search_complete: 'no',
      incomplete_sources: 'musicbrainz-deferred',
    });
  });

  it('does not report a search answered by a stored artist', async () => {
    mockFetch();
    const stored = {
      id: 'db-id',
      slug: 'zzqx-coverage-gap',
      name: QUERY,
      type: 'artist' as const,
      imageUrl: undefined,
      platforms: [{ sourceId: 'bandcamp', url: 'https://zzqxcoveragegap.bandcamp.com/' }],
      matchConfidence: 'verified' as const,
      profile: undefined,
      location: undefined,
    };
    mocks.getArtistBySlug.mockResolvedValue(stored);
    mocks.findKnownArtistSlugsByName.mockResolvedValue([stored.slug]);
    mocks.getArtistsBySlugs.mockResolvedValue(new Map([[stored.slug, stored]]));

    const response = await search();

    expect(JSON.parse(response.body).results.length).toBeGreaterThan(0);
    expect(zeroResultCaptures()).toHaveLength(0);
  });
});
