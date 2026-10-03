import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 1 used to wait for the whole MusicBrainz chain on every uncached search — a search,
// a 1.1s rate-limit gap, a lookup, then Discogs, Wikipedia, the official site and Linktree —
// before showing anything, though the web client already knew how to fill enrichment in
// afterwards from /api/search/musicbrainz.
//
// `enrichment=deferred` is how a client that makes that Phase 2 call says so. What must hold:
//   - deferred: no MusicBrainz request at all on a cache miss, and hasPendingEnrichment set so
//     the client does make the Phase 2 call;
//   - not deferred (the v1 API, Discord, the edge pages, shipped app builds): MusicBrainz is
//     still fetched inline, because those callers never make a second call.

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

import { handler } from '../search-sources';

function mockUpstreams() {
  // MusicBrainz knows nobody; every platform 404s. Enough to run the whole pipeline.
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/?query=')) {
      return new Response(JSON.stringify({ artists: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

function musicBrainzCalls(fetchSpy: ReturnType<typeof mockUpstreams>): string[] {
  return fetchSpy.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('https://musicbrainz.org/'));
}

beforeEach(() => {
  // No database: every lookup returns empty and nothing is written.
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('search-sources enrichment=deferred', () => {
  it('skips MusicBrainz on a cache miss and tells the client enrichment is pending', async () => {
    const fetchSpy = mockUpstreams();

    const response = await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    expect(response.statusCode).toBe(200);
    expect(musicBrainzCalls(fetchSpy)).toEqual([]);
    expect(JSON.parse(response.body).hasPendingEnrichment).toBe(true);
  });

  it('still fetches MusicBrainz inline when the caller did not ask to defer', async () => {
    const fetchSpy = mockUpstreams();

    const response = await handler({ queryStringParameters: { query: 'zzqx test artist' } });

    expect(response.statusCode).toBe(200);
    expect(musicBrainzCalls(fetchSpy).length).toBeGreaterThan(0);
  });

  it('reports where the time went', async () => {
    mockUpstreams();

    const response = await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });
    const serverTiming = (response.headers as Record<string, string>)['Server-Timing'];

    expect(serverTiming).toMatch(/bandcamp;dur=\d+/);
    expect(serverTiming).toMatch(/mb;dur=\d+;desc="deferred"/);
    expect(serverTiming).toMatch(/total;dur=\d+$/);
  });
});
