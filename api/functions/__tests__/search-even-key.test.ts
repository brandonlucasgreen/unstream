import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Even's Algolia search key is the public one even.biz ships to browsers, so it is built in: when
// it lived only in an env var, Netlify held it misspelled and then not at all, and Even search was
// off in production for months. If Even ever rotates it, Algolia's rejection must not be cached as
// "this artist isn't on Even", and it must be reported — once, not once per search.

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

function mockUpstreams(algoliaStatus = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('algolia.net')) {
      return algoliaStatus === 200
        ? new Response(JSON.stringify({ hits: [] }), { status: 200 })
        : new Response('{"message":"Invalid API key"}', { status: algoliaStatus });
    }
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/?query=')) {
      return new Response(JSON.stringify({ artists: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const evenReports = () =>
  captureMessage.mock.calls.filter(([message]) => String(message).startsWith('[EVEN]'));

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

describe('Even search key', () => {
  it('asks Even with the built-in key when no env var is set, and caches its answer', async () => {
    vi.stubEnv('ALGOLIA_API_KEY', '');
    const fetchSpy = mockUpstreams();

    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    const evenCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('algolia.net'));
    expect(evenCall).toBeDefined();
    const headers = evenCall![1]!.headers as Record<string, string>;
    expect(headers['X-Algolia-API-Key']).toMatch(/^[0-9a-f]{32}$/);
    expect(cacheDecisions.get(EVEN_KEY)).toBe(true);
    expect(evenReports()).toHaveLength(0);
  });

  it('prefers ALGOLIA_API_KEY when it is set', async () => {
    vi.stubEnv('ALGOLIA_API_KEY', 'override-key');
    const fetchSpy = mockUpstreams();

    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    const evenCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('algolia.net'));
    expect((evenCall![1]!.headers as Record<string, string>)['X-Algolia-API-Key']).toBe('override-key');
  });

  it('a rejected key is not cached as "not on Even", and is reported once', async () => {
    mockUpstreams(403);

    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });
    await handler({ queryStringParameters: { query: 'zzqx test artist', enrichment: 'deferred' } });

    expect(cacheDecisions.get(EVEN_KEY)).toBe(false);
    expect(evenReports()).toHaveLength(1);
  });
});
