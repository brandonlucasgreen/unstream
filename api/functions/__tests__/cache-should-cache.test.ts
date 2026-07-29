import { describe, it, expect, vi, beforeEach } from 'vitest';

// cacheGetOrFetch is meant to no-op its Redis calls here so these tests exercise the
// shouldCache decision itself (does the fetch get re-run, or was a failure remembered)
// rather than real cache state. That was true locally, where Upstash env vars are unset,
// but the Netlify build environment carries real production Upstash credentials — so
// without this mock, these tests write real keys ("t:ok", "t:ftl-ok", ...) to production
// Redis. Two deploys within the ~30 min TTL then hit a real cache HIT on a leftover key
// from the previous build, which skips the predicate call entirely and fails
// "accepts a failure TTL without disturbing the cacheable path". Mocking '../redis' makes
// getRedis() return null unconditionally, matching the file's original assumption.
vi.mock('../redis', () => ({
  getRedis: () => null,
  reportRedisFailure: vi.fn(),
}));

import { cacheGetOrFetch } from '../cache';

describe('cacheGetOrFetch shouldCache predicate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the fetched value whether or not it is cacheable', async () => {
    const ok = await cacheGetOrFetch('t:ok', async () => ({ v: 1 }), 60, () => true);
    expect(ok.data).toEqual({ v: 1 });
    expect(ok.cached).toBe(false);

    const notOk = await cacheGetOrFetch('t:notok', async () => null, 60, d => d !== null);
    expect(notOk.data).toBeNull();
    expect(notOk.cached).toBe(false);
  });

  it('calls the predicate with the fetched data exactly once', async () => {
    const predicate = vi.fn((d: { v: number }) => d.v > 0);
    await cacheGetOrFetch('t:pred', async () => ({ v: 7 }), 60, predicate);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith({ v: 7 });
  });

  it('treats an omitted predicate as "always cacheable" (existing callers unchanged)', async () => {
    const result = await cacheGetOrFetch('t:default', async () => 'value', 60);
    expect(result.data).toBe('value');
    expect(result.cached).toBe(false);
  });

  it('re-runs the fetch on a later call when the value was not cacheable', async () => {
    // The regression this guards: a MusicBrainz 503 was returned as a populated
    // all-nulls result and cached for 30 minutes, so one hiccup made an artist
    // look link-less until the TTL expired.
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      return attempts === 1 ? null : { artistName: 'Radiohead' };
    };
    const first = await cacheGetOrFetch('t:recover', fetchFn, 60, d => d !== null);
    const second = await cacheGetOrFetch('t:recover', fetchFn, 60, d => d !== null);

    expect(first.data).toBeNull();
    expect(second.data).toEqual({ artistName: 'Radiohead' });
    expect(attempts).toBe(2);
  });

  it('propagates a throwing fetch rather than caching anything', async () => {
    await expect(
      cacheGetOrFetch('t:throw', async () => { throw new Error('boom'); }, 60, () => true),
    ).rejects.toThrow('boom');
  });

  it('still returns the value when a failure TTL is supplied', async () => {
    // The failure TTL only changes how long an uncacheable value is remembered; it must
    // never change what this call returns.
    const result = await cacheGetOrFetch('t:ftl', async () => null, 1800, d => d !== null, 60);
    expect(result.data).toBeNull();
    expect(result.cached).toBe(false);
  });

  it('accepts a failure TTL without disturbing the cacheable path', async () => {
    const predicate = vi.fn((d: { v: number }) => d.v > 0);
    const result = await cacheGetOrFetch('t:ftl-ok', async () => ({ v: 3 }), 1800, predicate, 60);
    expect(result.data).toEqual({ v: 3 });
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  it('ignores a zero or negative failure TTL', async () => {
    // Guards the `failureTtlSeconds > 0` check — a 0 must mean "do not cache" rather
    // than being passed to Redis as an immediate-expiry write.
    for (const ttl of [0, -5]) {
      const result = await cacheGetOrFetch(`t:ftl-${ttl}`, async () => null, 1800, d => d !== null, ttl);
      expect(result.data).toBeNull();
    }
  });
});
