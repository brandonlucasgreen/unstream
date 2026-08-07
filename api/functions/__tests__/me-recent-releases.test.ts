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

import { handler, splitRecentReleases, RECENT_RELEASE_LIMIT } from '../me-recent-releases';
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

const NOW = new Date('2026-08-07T12:00:00Z');

describe('splitRecentReleases', () => {
  it('keeps an unreleased album out of the recent list', () => {
    const { upcoming, recent } = splitRecentReleases(
      [
        row({ releaseSlug: 'announced', releaseDate: '2026-09-30' }),
        row({ releaseSlug: 'out', releaseDate: '2026-08-05' }),
      ],
      NOW
    );

    expect(upcoming.map(r => r.releaseSlug)).toEqual(['announced']);
    expect(recent.map(r => r.releaseSlug)).toEqual(['out']);
  });

  it('counts a release dated today as out, not coming', () => {
    const { upcoming, recent } = splitRecentReleases([row({ releaseDate: '2026-08-07' })], NOW);

    expect(upcoming).toHaveLength(0);
    expect(recent).toHaveLength(1);
  });

  it('orders upcoming soonest first, so its cap drops the furthest off', () => {
    const { upcoming } = splitRecentReleases(
      [
        row({ releaseSlug: 'later', releaseDate: '2026-12-01' }),
        row({ releaseSlug: 'sooner', releaseDate: '2026-08-20' }),
        row({ releaseSlug: 'soonest', releaseDate: '2026-08-08' }),
      ],
      NOW,
      2
    );

    expect(upcoming.map(r => r.releaseSlug)).toEqual(['soonest', 'sooner']);
  });

  it('orders recent newest first, so its cap drops the oldest and never the news', () => {
    const { recent } = splitRecentReleases(
      [
        row({ releaseSlug: 'oldest', releaseDate: '2026-07-10' }),
        row({ releaseSlug: 'newest', releaseDate: '2026-08-05' }),
        row({ releaseSlug: 'middle', releaseDate: '2026-07-28' }),
      ],
      NOW,
      2
    );

    expect(recent.map(r => r.releaseSlug)).toEqual(['newest', 'middle']);
  });

  it('caps each list separately, so a run of announcements cannot hide what is out', () => {
    const { upcoming, recent } = splitRecentReleases(
      [
        ...Array.from({ length: RECENT_RELEASE_LIMIT + 2 }, (_, i) =>
          row({ releaseSlug: `soon-${i}`, releaseDate: `2026-09-0${i + 1}` })
        ),
        row({ releaseSlug: 'out', releaseDate: '2026-08-01' }),
      ],
      NOW
    );

    expect(upcoming).toHaveLength(RECENT_RELEASE_LIMIT);
    expect(recent.map(r => r.releaseSlug)).toEqual(['out']);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [row({ releaseSlug: 'a', releaseDate: '2026-07-01' }), row({ releaseSlug: 'b', releaseDate: '2026-08-01' })];
    splitRecentReleases(rows, NOW);
    expect(rows.map(r => r.releaseSlug)).toEqual(['a', 'b']);
  });

  it('keeps sources per-platform so the client can order them artist-paying-first', () => {
    const { recent } = splitRecentReleases(
      [
        row({
          sources: [
            { platform: 'discogs', url: 'https://discogs.com/x', offers: [{ price: 2.64, currency: 'USD', availability: 'available' }] },
            { platform: 'bandcamp', url: 'https://x.bandcamp.com/album/y', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
          ],
        }),
      ],
      NOW
    );

    expect(recent[0].sources).toEqual([
      { platform: 'discogs', offers: [{ price: 2.64, currency: 'USD', availability: 'available' }] },
      { platform: 'bandcamp', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
    ]);
  });

  it('carries date precision through, so a year-only date is never printed as a day', () => {
    const { recent } = splitRecentReleases([row({ datePrecision: 'year' })], NOW);
    expect(recent[0].datePrecision).toBe('year');
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

  it('returns the signed-in fan’s releases as two lists', async () => {
    // Dated in 2026-07 and 2100 rather than relative to today, so the split these assert stays the
    // same whenever the suite runs.
    mocks.getFeedReleasesForUser.mockResolvedValue([
      row({ releaseSlug: 'out', releaseDate: '2026-07-01' }),
      row({ releaseSlug: 'announced', releaseDate: '2100-01-01' }),
    ]);

    const res = await handler(GET);

    expect(res.statusCode).toBe(200);
    expect(mocks.getFeedReleasesForUser).toHaveBeenCalledWith('user-1');
    const body = JSON.parse(res.body!);
    expect(body.recent.map((r: { releaseSlug: string }) => r.releaseSlug)).toEqual(['out']);
    expect(body.upcoming.map((r: { releaseSlug: string }) => r.releaseSlug)).toEqual(['announced']);
    expect(body.recent[0].artistName).toBe('Explosions in the Sky');
  });

  it('caps each shortlist', async () => {
    mocks.getFeedReleasesForUser.mockResolvedValue([
      ...Array.from({ length: RECENT_RELEASE_LIMIT + 4 }, (_, i) =>
        row({ releaseSlug: `past-${i}`, releaseDate: `2026-07-0${(i % 9) + 1}` })
      ),
      ...Array.from({ length: RECENT_RELEASE_LIMIT + 4 }, (_, i) =>
        row({ releaseSlug: `future-${i}`, releaseDate: `210${i % 9}-01-01` })
      ),
    ]);

    const body = JSON.parse((await handler(GET)).body!);
    expect(body.recent).toHaveLength(RECENT_RELEASE_LIMIT);
    expect(body.upcoming).toHaveLength(RECENT_RELEASE_LIMIT);
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
