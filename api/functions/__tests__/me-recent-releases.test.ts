import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFeedReleasesForUser: vi.fn(),
  authGetUser: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../db', () => ({
  getFeedReleasesForUser: mocks.getFeedReleasesForUser,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.authGetUser } }),
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));

import { handler, toRecentReleases, RECENT_RELEASE_LIMIT } from '../me-recent-releases';
import type { FeedReleaseRow } from '../db';

function row(overrides: Partial<FeedReleaseRow> = {}): FeedReleaseRow {
  return {
    artistName: 'Explosions in the Sky',
    artistSlug: 'explosions-in-the-sky',
    title: 'The Earth Is Not a Cold Dead Place',
    releaseSlug: 'the-earth-is-not-a-cold-dead-place',
    releaseDate: '2026-08-01',
    datePrecision: 'day',
    offerSummary: '',
    platforms: [],
    artworkUrl: 'https://f4.bcbits.com/img/a1.jpg',
    sources: [
      {
        platform: 'bandcamp',
        url: 'https://explosionsinthesky.bandcamp.com/album/x',
        offers: [{ price: 8, currency: 'USD', availability: 'available' }],
      },
    ],
    ...overrides,
  };
}

const GET = {
  httpMethod: 'GET',
  headers: { authorization: 'Bearer valid-token' },
};

describe('toRecentReleases', () => {
  it('orders newest first, so the cap trims the oldest and never the news', () => {
    const ordered = toRecentReleases(
      [
        row({ releaseSlug: 'old', releaseDate: '2026-07-10' }),
        row({ releaseSlug: 'upcoming', releaseDate: '2026-09-30' }),
        row({ releaseSlug: 'recent', releaseDate: '2026-08-05' }),
      ],
      2
    );

    expect(ordered.map(r => r.releaseSlug)).toEqual(['upcoming', 'recent']);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [row({ releaseSlug: 'a', releaseDate: '2026-07-01' }), row({ releaseSlug: 'b', releaseDate: '2026-08-01' })];
    toRecentReleases(rows);
    expect(rows.map(r => r.releaseSlug)).toEqual(['a', 'b']);
  });

  it('keeps sources per-platform so the client can order them artist-paying-first', () => {
    const [release] = toRecentReleases([
      row({
        sources: [
          { platform: 'discogs', url: 'https://discogs.com/x', offers: [{ price: 2.64, currency: 'USD', availability: 'available' }] },
          { platform: 'bandcamp', url: 'https://x.bandcamp.com/album/y', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
        ],
      }),
    ]);

    expect(release.sources).toEqual([
      { platform: 'discogs', offers: [{ price: 2.64, currency: 'USD', availability: 'available' }] },
      { platform: 'bandcamp', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
    ]);
  });

  it('carries date precision through, so a year-only date is never printed as a day', () => {
    const [release] = toRecentReleases([row({ datePrecision: 'year' })]);
    expect(release.datePrecision).toBe('year');
  });
});

describe('me-recent-releases handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getClientIp.mockReturnValue('127.0.0.1');
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mocks.getFeedReleasesForUser.mockResolvedValue([]);
  });

  it('returns the signed-in fan’s releases', async () => {
    mocks.getFeedReleasesForUser.mockResolvedValue([row()]);

    const res = await handler(GET);

    expect(res.statusCode).toBe(200);
    expect(mocks.getFeedReleasesForUser).toHaveBeenCalledWith('user-1');
    const body = JSON.parse(res.body!);
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0].artistName).toBe('Explosions in the Sky');
  });

  it('caps the shortlist', async () => {
    mocks.getFeedReleasesForUser.mockResolvedValue(
      Array.from({ length: RECENT_RELEASE_LIMIT + 4 }, (_, i) =>
        row({ releaseSlug: `r${i}`, releaseDate: `2026-08-0${(i % 9) + 1}` })
      )
    );

    const res = await handler(GET);
    expect(JSON.parse(res.body!).releases).toHaveLength(RECENT_RELEASE_LIMIT);
  });

  it('401s without a valid bearer token, and never reads the database', async () => {
    mocks.authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad token' } });

    const res = await handler(GET);

    expect(res.statusCode).toBe(401);
    expect(mocks.getFeedReleasesForUser).not.toHaveBeenCalled();
  });

  it('401s with no Authorization header at all', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(401);
    expect(mocks.getFeedReleasesForUser).not.toHaveBeenCalled();
  });

  it('never lets a shared cache keep one fan’s list', async () => {
    const res = await handler(GET);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('answers preflight and refuses other methods', async () => {
    expect((await handler({ httpMethod: 'OPTIONS', headers: {} })).statusCode).toBe(204);
    expect((await handler({ ...GET, httpMethod: 'POST' })).statusCode).toBe(405);
  });

  it('passes the rate limiter’s refusal straight through', async () => {
    mocks.checkRateLimit.mockResolvedValue({
      limited: true,
      response: { statusCode: 429, headers: {}, body: '{}' },
    });

    const res = await handler(GET);

    expect(res.statusCode).toBe(429);
    expect(mocks.getFeedReleasesForUser).not.toHaveBeenCalled();
  });
});
