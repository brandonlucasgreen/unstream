// getMergeOverrides / getLinkSuppressions are read in full on *every search*, so they are cached
// for five minutes. What has to hold is the thing CLAUDE.md calls "never cache uncertainty":
// both functions return `[]` when the table is genuinely empty *and* `[]` when the read failed,
// and caching the second would suppress every merge override for a full TTL because Supabase
// blipped once.
//
// A real Redis is stubbed out (see cache-should-cache.test.ts for why that matters on Netlify);
// these tests assert on whether the underlying Supabase read is re-run, which is the observable
// consequence of the caching decision.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  select: vi.fn(),
}));

// A minimal in-memory stand-in for Upstash, so a cached value really is served from cache.
vi.mock('../redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mocks.store.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      mocks.store.set(key, value);
    },
    del: async (key: string) => {
      mocks.store.delete(key);
    },
  }),
  reportRedisFailure: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ select: mocks.select }) }),
}));

const { getMergeOverrides, getLinkSuppressions, invalidateAdminListCache, resetAdminListMemoForTests } = await import('../db');

const ROW = { id: 'o1', group_name: 'Big Thief', platform_urls: [], excluded_urls: [], canonical_image_url: null };
const SUPPRESSION_ROW = { url: 'https://example.bandcamp.com', artist_name_norm: 'someone' };

beforeEach(() => {
  mocks.store.clear();
  // Both layers, not just Redis: these lists are also memoized in-process for a minute, and a
  // memo surviving into the next test would make every assertion below read the previous
  // test's answer.
  resetAdminListMemoForTests();
  mocks.select.mockReset();
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
});

describe('getMergeOverrides caching', () => {
  it('reads Supabase once and serves the second call from cache', async () => {
    mocks.select.mockResolvedValue({ data: [ROW], error: null });

    expect(await getMergeOverrides()).toEqual([ROW]);
    expect(await getMergeOverrides()).toEqual([ROW]);

    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  // The whole point. A failed read must not become five minutes of "there are no overrides".
  it('does not cache a failed read', async () => {
    mocks.select.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    expect(await getMergeOverrides()).toEqual([]);
    expect(await getMergeOverrides()).toEqual([]);

    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  // An empty table is a real answer and is safe to remember, unlike the case above. Without this
  // distinction the two are indistinguishable and the cache has to refuse both.
  it('caches a genuinely empty table', async () => {
    mocks.select.mockResolvedValue({ data: [], error: null });

    expect(await getMergeOverrides()).toEqual([]);
    expect(await getMergeOverrides()).toEqual([]);

    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  // A failed read heals on the next request rather than persisting, so the recovery path is a
  // fresh read returning real data — not a cached empty list.
  it('recovers on the next call after a failure', async () => {
    mocks.select.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    mocks.select.mockResolvedValue({ data: [ROW], error: null });

    expect(await getMergeOverrides()).toEqual([]);
    expect(await getMergeOverrides()).toEqual([ROW]);
  });

  it('re-reads after the cache is invalidated, so an admin edit is not stuck behind the TTL', async () => {
    mocks.select.mockResolvedValue({ data: [], error: null });
    expect(await getMergeOverrides()).toEqual([]);

    await invalidateAdminListCache('merge-overrides');
    mocks.select.mockResolvedValue({ data: [ROW], error: null });

    expect(await getMergeOverrides()).toEqual([ROW]);
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });
});

describe('getLinkSuppressions caching', () => {
  const SUPPRESSION = { url: 'https://example.bandcamp.com', artist_name_norm: 'someone' };

  it('reads Supabase once and serves the second call from cache', async () => {
    mocks.select.mockResolvedValue({ data: [SUPPRESSION], error: null });

    expect(await getLinkSuppressions()).toEqual([SUPPRESSION]);
    expect(await getLinkSuppressions()).toEqual([SUPPRESSION]);

    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  // Failing open here means a known-bad link reappears. Caching that failure would keep it
  // visible for the full TTL instead of one request.
  it('does not cache a failed read', async () => {
    mocks.select.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    expect(await getLinkSuppressions()).toEqual([]);
    expect(await getLinkSuppressions()).toEqual([]);

    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it('re-reads after invalidation so a new suppression takes effect immediately', async () => {
    mocks.select.mockResolvedValue({ data: [], error: null });
    expect(await getLinkSuppressions()).toEqual([]);

    await invalidateAdminListCache('link-suppressions');
    mocks.select.mockResolvedValue({ data: [SUPPRESSION], error: null });

    expect(await getLinkSuppressions()).toEqual([SUPPRESSION]);
  });

  // The two lists must not share a cache key — one invalidation would then wipe the other, and
  // worse, one table's rows could be served as the other's.
  it('keeps its cache separate from merge overrides', async () => {
    mocks.select.mockResolvedValue({ data: [SUPPRESSION], error: null });
    await getLinkSuppressions();

    mocks.select.mockResolvedValue({ data: [ROW], error: null });
    expect(await getMergeOverrides()).toEqual([ROW]);
  });
});

// The in-process memo in front of Redis. It exists because Redis is not free: these two lists
// are read on every search and again during Phase 2 enrichment, which was two Upstash commands
// per search for two lists that are identical for every visitor.
describe('in-process memo', () => {
  it('answers a repeat read without touching Redis at all', async () => {
    mocks.select.mockResolvedValue({ data: [ROW], error: null });
    expect(await getMergeOverrides()).toEqual([ROW]);

    // Emptying the Redis stub would force a Supabase re-read if the memo were not in front
    // of it. Serving [ROW] anyway is the proof no Redis command was spent.
    mocks.store.clear();
    expect(await getMergeOverrides()).toEqual([ROW]);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('does not memoize a failed read', async () => {
    mocks.select.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    expect(await getMergeOverrides()).toEqual([]);

    mocks.select.mockResolvedValue({ data: [ROW], error: null });
    expect(await getMergeOverrides()).toEqual([ROW]);
  });

  it('is cleared by invalidation, so the admin who made the change sees it immediately', async () => {
    mocks.select.mockResolvedValue({ data: [], error: null });
    expect(await getMergeOverrides()).toEqual([]);

    await invalidateAdminListCache('merge-overrides');
    mocks.select.mockResolvedValue({ data: [ROW], error: null });

    expect(await getMergeOverrides()).toEqual([ROW]);
  });

  it('keeps the two lists apart', async () => {
    mocks.select.mockResolvedValue({ data: [SUPPRESSION_ROW], error: null });
    expect(await getLinkSuppressions()).toEqual([SUPPRESSION_ROW]);

    mocks.select.mockResolvedValue({ data: [ROW], error: null });
    expect(await getMergeOverrides()).toEqual([ROW]);

    // And invalidating one must not drop the other's memo.
    await invalidateAdminListCache('merge-overrides');
    mocks.store.clear();
    mocks.select.mockResolvedValue({ data: null, error: { message: 'should not be reached' } });
    expect(await getLinkSuppressions()).toEqual([SUPPRESSION_ROW]);
  });
});
