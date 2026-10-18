// Phase 1 search hands persistence to request-persist.ts instead of awaiting persistSearchResults
// itself, so the response no longer waits on Supabase's writes. These pin the search side: it
// never calls persistSearchResults directly, the handoff shows in Server-Timing, and the response
// a fan gets is the same however the handoff went.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  persistSearchResults: vi.fn(async () => {}),
  requestSearchPersist: vi.fn(async () => 'background'),
  getArtistBySlug: vi.fn(async () => null),
  getArtistsBySlugs: vi.fn(async () => new Map()),
  findKnownArtistSlugsByName: vi.fn(async () => []),
}));

vi.mock('../db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db')>();
  return {
    ...original,
    persistSearchResults: mocks.persistSearchResults,
    getArtistBySlug: mocks.getArtistBySlug,
    getArtistsBySlugs: mocks.getArtistsBySlugs,
    findKnownArtistSlugsByName: mocks.findKnownArtistSlugsByName,
    getMergeOverrides: vi.fn(async () => []),
    getLinkSuppressions: vi.fn(async () => []),
  };
});

vi.mock('../request-persist', () => ({ requestSearchPersist: mocks.requestSearchPersist }));

import { handler } from '../search-sources';

beforeEach(() => {
  vi.clearAllMocks();
  // Every platform and MusicBrainz 404s; what matters here is what happens after the fan-out.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function search() {
  const response = await handler({ queryStringParameters: { query: 'zzqx handoff artist' } });
  if (!response) throw new Error('search handler returned no response');
  return response;
}

describe('search persistence handoff', () => {
  it('hands results to the dispatcher and never writes them itself', async () => {
    const response = await search();

    expect(response.statusCode).toBe(200);
    expect(mocks.requestSearchPersist).toHaveBeenCalledTimes(1);
    expect(Array.isArray(mocks.requestSearchPersist.mock.calls[0][0])).toBe(true);
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
  });

  it('reports the handoff, and how it went, in Server-Timing', async () => {
    mocks.requestSearchPersist.mockResolvedValueOnce('inline-dispatch-failed');

    const response = await search();

    expect(response.headers?.['Server-Timing']).toMatch(/persist;dur=\d+;desc="inline-dispatch-failed"/);
  });

  it('answers with the same results whether persistence ran in the background or inline', async () => {
    mocks.requestSearchPersist.mockResolvedValueOnce('background');
    const background = JSON.parse((await search()).body);
    mocks.requestSearchPersist.mockResolvedValueOnce('inline-dispatch-failed');
    const inline = JSON.parse((await search()).body);

    expect(inline).toEqual(background);
  });
});
