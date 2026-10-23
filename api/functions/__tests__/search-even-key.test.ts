import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Netlify held Even's key as ALGOLAI_API_KEY while the code reads ALGOLIA_API_KEY, so for months
// every search skipped Even and cached the empty answer as "this artist isn't on Even", with
// nothing reported. A missing key is a deployment fault: it must not be cached as a negative, and
// it must be reported — once, not once per search.

vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('../../lib/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sentry')>();
  return { ...actual, Sentry: { ...actual.Sentry, captureMessage } };
});

// Record whether each platform's answer would have been cached.
const { cacheDecisions } = vi.hoisted(() => ({ cacheDecisions: new Map<string, boolean>() }));
vi.mock('../cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cache')>();
  return {
    ...actual,
    cacheGetOrFetch: async <T>(key: string, fetchFn: () => Promise<T>, _ttl?: number, shouldCache?: (data: T) => boolean) => {
      const data = await fetchFn();
      cacheDecisions.set(key, shouldCache ? shouldCache(data) : true);
      return { data, cached: false };
    },
  };
});

import { handler } from '../search-sources';

const EVEN_KEY = 'artist:even:zzqx_test_artist';

function mockUpstreams() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('algolia.net')) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/?query=')) {
      return new Response(JSON.stringify({ artists: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const evenReports = () =>
  captureMessage.mock.calls.filter(([message]) => String(message).includes('ALGOLIA_API_KEY'));

beforeEach(() => {
  cacheDecisions.clear();
  captureMessage.mockClear();
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Even search without its key', () => {
  it('does not cache the empty answer as "not on Even", and reports it once', async () => {
    vi.stubEnv('ALGOLIA_API_KEY', '');
    mockUpstreams();

    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });
    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    expect(cacheDecisions.get(EVEN_KEY)).toBe(false);
    expect(evenReports()).toHaveLength(1);
  });

  it('with the key, asks Even and caches its answer as usual', async () => {
    vi.stubEnv('ALGOLIA_API_KEY', 'public-search-key');
    const fetchSpy = mockUpstreams();

    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('algolia.net'))).toBe(true);
    expect(cacheDecisions.get(EVEN_KEY)).toBe(true);
  });
});
