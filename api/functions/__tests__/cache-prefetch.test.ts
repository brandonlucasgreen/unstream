import { describe, it, expect, vi, beforeEach } from 'vitest';

// Upstash bills per command, and the search fan-out reads one key per platform for the same
// query. Five separate GETs per search is five billed commands where MGET is one — enough,
// at this site's traffic, to be a real share of the 500k-command free tier. These tests pin
// the two properties that make the batch safe to substitute for those GETs: it must not
// invent hits, and a prefetched miss must still fetch and still write back.
//
// A real Redis is stubbed out (see cache-should-cache.test.ts for why that matters on the
// Netlify build, which carries production Upstash credentials).

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  mget: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  reportRedisFailure: vi.fn(),
}));

vi.mock('../redis', () => ({
  getRedis: () => ({
    mget: (...keys: string[]) => mocks.mget(...keys),
    get: (key: string) => mocks.get(key),
    set: (key: string, value: unknown, opts: unknown) => mocks.set(key, value, opts),
  }),
  reportRedisFailure: mocks.reportRedisFailure,
}));

const { cachePrefetch, cacheGetOrFetch } = await import('../cache');

beforeEach(() => {
  mocks.store.clear();
  mocks.mget.mockReset();
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.reportRedisFailure.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.mget.mockImplementation(async (...keys: string[]) =>
    keys.map(k => (mocks.store.has(k) ? mocks.store.get(k) : null)));
  mocks.set.mockImplementation(async (key: string, value: unknown) => {
    mocks.store.set(key, value);
    return 'OK';
  });
});

describe('cachePrefetch', () => {
  it('reads every key in a single command', async () => {
    mocks.store.set('artist:mirlo:x', ['a']);
    mocks.store.set('artist:even:x', ['b']);

    const found = await cachePrefetch(['artist:mirlo:x', 'artist:patreon:x', 'artist:even:x']);

    expect(mocks.mget).toHaveBeenCalledTimes(1);
    expect(mocks.mget).toHaveBeenCalledWith('artist:mirlo:x', 'artist:patreon:x', 'artist:even:x');
    // Only the keys Redis actually held. A miss is an absent key, never a null entry — the
    // difference is what lets cacheGetOrFetch tell "cached nothing" from "not cached".
    expect([...found.keys()]).toEqual(['artist:mirlo:x', 'artist:even:x']);
  });

  it('spends nothing when there is nothing to read', async () => {
    expect((await cachePrefetch([])).size).toBe(0);
    expect(mocks.mget).not.toHaveBeenCalled();
  });

  // A failed prefetch looks exactly like a cold cache to every caller, which is why — as with
  // cacheGet — it has to reach Sentry rather than being swallowed.
  it('degrades to a cold cache and reports the failure', async () => {
    mocks.mget.mockRejectedValue(new Error('upstash down'));

    expect((await cachePrefetch(['artist:mirlo:x'])).size).toBe(0);
    expect(mocks.reportRedisFailure).toHaveBeenCalledTimes(1);
  });
});

describe('cacheGetOrFetch with a prefetched batch', () => {
  it('serves a prefetched hit without a second read', async () => {
    mocks.store.set('artist:mirlo:x', ['cached']);
    const prefetched = await cachePrefetch(['artist:mirlo:x']);

    const fetchFn = vi.fn(async () => ['fresh']);
    const result = await cacheGetOrFetch('artist:mirlo:x', fetchFn, 60, undefined, undefined, prefetched);

    expect(result).toEqual({ data: ['cached'], cached: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  // The batch is authoritative for the keys it was asked for: the caller has already asked
  // Redis about them, so an absent key is a miss and re-reading it would spend the command
  // the batch exists to save.
  it('treats an absent key as a miss without re-reading it', async () => {
    const prefetched = await cachePrefetch(['artist:mirlo:x']);

    const fetchFn = vi.fn(async () => ['fresh']);
    const result = await cacheGetOrFetch('artist:mirlo:x', fetchFn, 60, undefined, undefined, prefetched);

    expect(result).toEqual({ data: ['fresh'], cached: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('still writes back on a prefetched miss, so the next search hits', async () => {
    const prefetched = await cachePrefetch(['artist:mirlo:x']);
    await cacheGetOrFetch('artist:mirlo:x', async () => ['fresh'], 60, undefined, undefined, prefetched);

    expect(mocks.set).toHaveBeenCalledWith('artist:mirlo:x', ['fresh'], { ex: 60 });
  });

  // Batching must not weaken "never cache uncertainty" — the predicate still decides.
  it('still refuses to cache a value the predicate rejects', async () => {
    const prefetched = await cachePrefetch(['artist:mirlo:x']);
    await cacheGetOrFetch('artist:mirlo:x', async () => null, 60, d => d !== null, undefined, prefetched);

    expect(mocks.set).not.toHaveBeenCalled();
  });

  // The search fan-out passes the MGET *promise*, not an awaited map, so the platforms with
  // no cache don't start a round trip later than they used to. This is the production path.
  it('accepts the in-flight batch, so the fan-out need not wait on it', async () => {
    mocks.store.set('artist:mirlo:x', ['cached']);
    const inFlight = cachePrefetch(['artist:mirlo:x']);

    const fetchFn = vi.fn(async () => ['fresh']);
    const result = await cacheGetOrFetch('artist:mirlo:x', fetchFn, 60, undefined, undefined, inFlight);

    expect(result).toEqual({ data: ['cached'], cached: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    // One MGET serves every reader of the same batch, which is the whole saving.
    expect(mocks.mget).toHaveBeenCalledTimes(1);
  });

  it('falls back to a single GET when no batch is supplied', async () => {
    mocks.get.mockResolvedValue(['cached']);

    const result = await cacheGetOrFetch('artist:mirlo:x', async () => ['fresh'], 60);

    expect(result).toEqual({ data: ['cached'], cached: true });
    expect(mocks.get).toHaveBeenCalledWith('artist:mirlo:x');
  });
});
