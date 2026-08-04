import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(() => ({ from: mocks.mockFrom })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));

import { handler } from '../artist-directory';

/** PostgREST's `max-rows` on this project. Reads above it are truncated silently. */
const CAP = 1000;

/**
 * A filtered query that behaves the way PostgREST really does.
 *
 * Awaiting it directly — the bare `.select().eq()` this endpoint used to do — resolves to the
 * *first `CAP` rows only*, with `error: null`, exactly as production would. `.range(from, to)`
 * returns that window instead. So a handler that forgets to page still gets a successful-looking
 * response here and fails on the row count, which is the failure that matters.
 */
function cappedQuery<T>(rows: T[]) {
  const respond = (data: T[]) => Promise.resolve({ data, error: null });
  return {
    range: vi.fn((from: number, to: number) => respond(rows.slice(from, to + 1))),
    then: (
      onFulfilled: (value: { data: T[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => respond(rows.slice(0, CAP)).then(onFulfilled, onRejected),
  };
}

function verifiedArtists(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    slug: `artist-${String(i).padStart(4, '0')}`,
    name: `Artist ${String(i).padStart(4, '0')}`,
    image_url: null,
  }));
}

describe('artist-directory handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockCreateClient.mockReturnValue({ from: mocks.mockFrom });
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
  });

  it('scope=known lists verified (unclaimed) artists, sorted by name, with no join', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn((column: string, value: string) => {
          expect(column).toBe('match_confidence');
          expect(value).toBe('verified');
          return cappedQuery([
            { slug: 'zzz-artist', name: 'ZZZ Artist', image_url: null },
            { slug: 'patrick-hardy', name: 'Patrick Hardy', image_url: 'https://img/p.jpg' },
          ]);
        }),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'known' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.artists).toEqual([
      { slug: 'patrick-hardy', name: 'Patrick Hardy', imageUrl: 'https://img/p.jpg' },
      { slug: 'zzz-artist', name: 'ZZZ Artist', imageUrl: null },
    ]);
    // Only one table touched — no artist_profiles join for the known scope.
    expect(mocks.mockFrom).toHaveBeenCalledWith('artists');
    expect(mocks.mockFrom).not.toHaveBeenCalledWith('artist_profiles');
  });

  // The regression this endpoint was one page away from: 958 verified artists in production on
  // 2026-08-04, and a bare .select() drops everything past 1,000 with no error to notice.
  it('scope=known pages past the 1,000-row PostgREST cap instead of truncating', async () => {
    const rows = verifiedArtists(1042);
    const eq = vi.fn(() => cappedQuery(rows));
    mocks.mockFrom.mockReturnValue({ select: vi.fn(() => ({ eq })) });

    const res = await handler({ queryStringParameters: { scope: 'known' } });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.artists).toHaveLength(1042);
    // The tail is the part a truncated read loses.
    expect(body.artists[1041]).toEqual({ slug: 'artist-1041', name: 'Artist 1041', imageUrl: null });
    expect(new Set(body.artists.map((a: { slug: string }) => a.slug)).size).toBe(1042);

    // Two ranged pages: rows 0–999 (full, so keep going) then 1000–1999 (short, so stop).
    const ranges = eq.mock.results.flatMap(r => (r.value as { range: { mock: { calls: number[][] } } }).range.mock.calls);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });

  it('scope=known returns 500 on a query error', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          range: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
        })),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'known' } });
    expect(res.statusCode).toBe(500);
  });

  it('default scope lists claimed (verified profile) artists via the artist_profiles join', async () => {
    mocks.mockFrom
      .mockReturnValueOnce({
        select: vi.fn(() => ({
          not: vi.fn(() => cappedQuery([{ artist_id: 'a1', custom_image_url: null }])),
        })),
      })
      .mockReturnValueOnce({
        select: vi.fn(() => ({
          in: vi.fn(() => Promise.resolve({
            data: [{ id: 'a1', name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', image_url: 'https://img/k.jpg' }],
            error: null,
          })),
        })),
      });

    const res = await handler({});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.artists).toEqual([
      { slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: 'https://img/k.jpg' },
    ]);
    expect(mocks.mockFrom).toHaveBeenCalledWith('artist_profiles');
    expect(mocks.mockFrom).toHaveBeenCalledWith('artists');
  });

  // Same cap on artist_profiles, plus the id list going into a query string: 1,150 claimed
  // profiles must come back as 1,150 artists, fetched in bounded .in() chunks.
  it('default scope pages the profile read and chunks the id lookup', async () => {
    const profiles = Array.from({ length: 1150 }, (_, i) => ({
      artist_id: `id-${String(i).padStart(4, '0')}`,
      custom_image_url: null,
    }));

    const inCalls: string[][] = [];
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'artist_profiles') {
        return { select: vi.fn(() => ({ not: vi.fn(() => cappedQuery(profiles)) })) };
      }
      return {
        select: vi.fn(() => ({
          in: vi.fn((column: string, ids: string[]) => {
            expect(column).toBe('id');
            inCalls.push(ids);
            return Promise.resolve({
              // Capped like the real thing, so an unchunked .in() over every id loses the tail.
              data: ids.slice(0, CAP).map(id => ({
                id,
                name: `Artist ${id.slice(3)}`,
                slug: `artist-${id.slice(3)}`,
                image_url: null,
              })),
              error: null,
            });
          }),
        })),
      };
    });

    const res = await handler({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artists).toHaveLength(1150);

    // Every id asked about exactly once, and no chunk large enough to hit the cap or a 414.
    expect(inCalls.flat()).toEqual(profiles.map(p => p.artist_id));
    expect(Math.max(...inCalls.map(c => c.length))).toBeLessThanOrEqual(200);
  });

  it('default scope returns an uncacheable 500 when the profile read fails, not an empty list', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        not: vi.fn(() => ({
          range: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
        })),
      })),
    });

    const res = await handler({});
    expect(res.statusCode).toBe(500);
    // A 200 here would be cached for five minutes as "there are no claimed artists".
    expect(res.headers).toBeUndefined();
  });

  it('an unrecognized scope value falls back to the claimed (default) path', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        not: vi.fn(() => cappedQuery([])),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'bogus' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artists).toEqual([]);
    expect(mocks.mockFrom).toHaveBeenCalledWith('artist_profiles');
  });
});
