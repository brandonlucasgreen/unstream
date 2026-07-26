import { describe, it, expect, vi, beforeEach } from 'vitest';

// cacheGetOrFetch no-ops its Redis calls when Upstash is unconfigured, which is the
// case here — so these tests exercise the shouldCache decision itself: does the
// fetch get re-run, or was a failure remembered?

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
});
