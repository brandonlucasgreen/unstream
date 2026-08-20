// /api/analytics/event accepts two body shapes: { slug, metric } — one event, what the
// extension and Mac app send — and { slugs: [...], metric } — the web app's batched search
// appearances. The batch exists for the write bill: a search that rendered N claimed artists
// used to cost N requests and N increment transactions; it must now cost one request, at most
// one slug-resolution read, and exactly one RPC.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockIn: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({
    from: () => ({ select: () => ({ in: mocks.mockIn, eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }),
    rpc: mocks.mockRpc,
  }),
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '203.0.113.7',
}));

import { handler } from '../analytics-event';

const ARTISTS: Record<string, string> = {
  'artist-a': 'id-a',
  'artist-b': 'id-b',
};

function post(body: unknown) {
  return handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockIn.mockImplementation((_column: string, slugs: string[]) =>
    Promise.resolve({
      data: slugs.filter(s => ARTISTS[s]).map(s => ({ id: ARTISTS[s], slug: s })),
      error: null,
    })
  );
  mocks.mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('batched slugs', () => {
  it('resolves the batch in one read and increments in one RPC', async () => {
    // A fresh slug per test would fight the module-level slug cache; unique slugs per case
    // keep each test's read observable.
    const res = await post({ slugs: ['artist-a', 'artist-b', 'artist-a'], metric: 'search' });

    expect(res?.statusCode).toBe(204);
    expect(mocks.mockIn).toHaveBeenCalledTimes(1);
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.mockRpc.mock.calls[0];
    expect(fn).toBe('increment_analytics_batch');
    expect((args as { p_artist_ids: string[] }).p_artist_ids.sort()).toEqual(['id-a', 'id-b']);
    expect(args).toMatchObject({ p_metric: 'search' });
  });

  it('serves a repeat batch from the warm slug cache with no read at all', async () => {
    await post({ slugs: ['artist-a', 'artist-b'], metric: 'search' });
    mocks.mockIn.mockClear();

    await post({ slugs: ['artist-a', 'artist-b'], metric: 'search' });

    expect(mocks.mockIn).not.toHaveBeenCalled();
    expect(mocks.mockRpc).toHaveBeenLastCalledWith('increment_analytics_batch', expect.anything());
  });

  it('drops unknown slugs and no-ops when none resolve', async () => {
    const res = await post({ slugs: ['nobody-here', 'nor-here'], metric: 'search' });

    expect(res?.statusCode).toBe(204);
    expect(mocks.mockRpc).not.toHaveBeenCalled();
  });

  it('refuses a batch bigger than any real search by truncating it', async () => {
    const slugs = Array.from({ length: 40 }, (_, i) => `flood-${i}`);
    await post({ slugs, metric: 'search' });

    const asked = mocks.mockIn.mock.calls[0][1] as string[];
    expect(asked.length).toBeLessThanOrEqual(24);
  });
});

describe('the single-event shape (extension and Mac app)', () => {
  it('still increments through the single-row RPC', async () => {
    await post({ slug: 'artist-a', metric: 'view' });

    expect(mocks.mockRpc).toHaveBeenCalledTimes(1);
    expect(mocks.mockRpc).toHaveBeenCalledWith('increment_analytics', {
      p_artist_id: 'id-a',
      p_date: expect.any(String),
      p_metric: 'view',
    });
  });

  it('no-ops an invalid metric without touching the database', async () => {
    const res = await post({ slug: 'artist-a', metric: 'drop table' });

    expect(res?.statusCode).toBe(204);
    expect(mocks.mockRpc).not.toHaveBeenCalled();
  });
});
