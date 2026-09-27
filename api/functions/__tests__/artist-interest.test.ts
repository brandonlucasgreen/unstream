// /api/artist-interest — "I'd tip them" and Play my city (docs/specs/artist-patronage-spec.md §3.5,
// §3.6). What's locked here: only a signed-in fan can tap, one row per fan per artist, the city is
// cleaned and keyed server-side, and the full (unthresholded) counts reach only the artist's owner.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

const mocks = vi.hoisted(() => ({
  resolveOwnedArtist: vi.fn(),
  getArtistInterestCounts: vi.fn(),
  getCitySuggestions: vi.fn(),
  checkRateLimit: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

/** A PostgREST-shaped fake over `tables`: enough of select/eq/in/upsert/delete for this endpoint. */
function makeClient() {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const rows = () => (tables[table] ??= []);
      const matching = () => rows().filter(r =>
        filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return builder; },
        in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        then: (res: (r: unknown) => unknown) => Promise.resolve({ data: matching(), error: null }).then(res),
        upsert(row: Row, opts: { onConflict: string; ignoreDuplicates?: boolean }) {
          const keys = opts.onConflict.split(',');
          const existing = rows().find(r => keys.every(k => r[k] === row[k]));
          if (existing && !opts.ignoreDuplicates) Object.assign(existing, row);
          if (!existing) rows().push({ ...row });
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          const chain = {
            eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
            then: (res: (r: unknown) => unknown) => {
              const hit = matching();
              tables[table] = rows().filter(r => !hit.includes(r));
              return Promise.resolve({ data: null, error: null }).then(res);
            },
          };
          return chain;
        },
      };
      return builder;
    },
  };
}

vi.mock('../db', () => ({
  getClient: () => makeClient(),
  resolveOwnedArtist: mocks.resolveOwnedArtist,
}));
vi.mock('../interest-counts', () => ({
  getArtistInterestCounts: mocks.getArtistInterestCounts,
  getCitySuggestions: mocks.getCitySuggestions,
  DASHBOARD_COUNTS: { min: 1, limit: 10 },
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
}));

const REJECTED_TOKEN = 'Bearer rejected-token';
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader && authHeader !== REJECTED_TOKEN
      ? { key: 'user:fan-1', user: { userId: 'fan-1', email: 'fan@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '127.0.0.1',
}));

import { handler as rawHandler } from '../artist-interest';

// The handler's type allows undefined (checkRateLimit's `response` is optional); every path here returns one.
const handler = async (event: Parameters<typeof rawHandler>[0]) => (await rawHandler(event))!;

const auth = { authorization: 'Bearer good-token' };
const post = (body: unknown, headers: Record<string, string> = auth) =>
  handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
const del = (body: unknown) => handler({ httpMethod: 'DELETE', headers: auth, body: JSON.stringify(body) });
const get = (params: Record<string, string> = {}) =>
  handler({ httpMethod: 'GET', headers: auth, body: null, queryStringParameters: params });

beforeEach(() => {
  vi.resetAllMocks();
  for (const k of Object.keys(tables)) delete tables[k];
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  tables.artists = [{ id: 'a-1', slug: 'kid-lightbulbs' }, { id: 'a-2', slug: 'big-thief' }];
});

describe('auth', () => {
  it('refuses a request with no token', async () => {
    const res = await post({ slug: 'kid-lightbulbs', kind: 'tip' }, {});
    expect(res.statusCode).toBe(401);
    expect(tables.tip_interest ?? []).toHaveLength(0);
  });

  it('refuses a token that does not verify', async () => {
    const res = await post({ slug: 'kid-lightbulbs', kind: 'tip' }, { authorization: REJECTED_TOKEN });
    expect(res.statusCode).toBe(401);
  });

  it('returns the limiter response when rate limited', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: { statusCode: 429, headers: {}, body: '' } });
    const res = await post({ slug: 'kid-lightbulbs', kind: 'tip' });
    expect(res.statusCode).toBe(429);
  });
});

describe("\"I'd tip them\"", () => {
  it('records one row per fan per artist, however often they tap', async () => {
    await post({ slug: 'kid-lightbulbs', kind: 'tip' });
    const res = await post({ slug: 'kid-lightbulbs', kind: 'tip' });
    expect(res.statusCode).toBe(200);
    expect(tables.tip_interest).toEqual([{ artist_id: 'a-1', user_id: 'fan-1' }]);
  });

  it('never records an amount', async () => {
    await post({ slug: 'kid-lightbulbs', kind: 'tip', amount: 500 });
    expect(Object.keys(tables.tip_interest[0]).sort()).toEqual(['artist_id', 'user_id']);
  });

  it('takes it back on DELETE, touching only this fan', async () => {
    tables.tip_interest = [{ artist_id: 'a-1', user_id: 'fan-1' }, { artist_id: 'a-1', user_id: 'fan-2' }];
    const res = await del({ slug: 'kid-lightbulbs', kind: 'tip' });
    expect(res.statusCode).toBe(200);
    expect(tables.tip_interest).toEqual([{ artist_id: 'a-1', user_id: 'fan-2' }]);
  });

  it('404s an artist with no row rather than creating interest on nothing', async () => {
    const res = await post({ slug: 'nobody-at-all', kind: 'tip' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed slug and an unknown kind', async () => {
    expect((await post({ slug: '../etc', kind: 'tip' })).statusCode).toBe(400);
    expect((await post({ slug: 'kid-lightbulbs', kind: 'money' })).statusCode).toBe(400);
    expect((await handler({ httpMethod: 'POST', headers: auth, body: '{nope' })).statusCode).toBe(400);
  });
});

describe('Play my city', () => {
  it('stores the cleaned label and its key', async () => {
    const res = await post({ slug: 'kid-lightbulbs', kind: 'city', city: '  Boston   MA ' });
    expect(res.statusCode).toBe(200);
    expect(tables.city_interest).toEqual([
      { artist_id: 'a-1', user_id: 'fan-1', city_key: 'boston ma', city_label: 'Boston MA' },
    ]);
  });

  it('keeps one city per fan per artist: a second POST changes it', async () => {
    await post({ slug: 'kid-lightbulbs', kind: 'city', city: 'Boston' });
    await post({ slug: 'kid-lightbulbs', kind: 'city', city: 'Leeds' });
    expect(tables.city_interest).toHaveLength(1);
    expect(tables.city_interest[0].city_label).toBe('Leeds');
  });

  it('rejects an empty, oversized or markup-carrying city', async () => {
    expect((await post({ slug: 'kid-lightbulbs', kind: 'city', city: '   ' })).statusCode).toBe(400);
    expect((await post({ slug: 'kid-lightbulbs', kind: 'city', city: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await post({ slug: 'kid-lightbulbs', kind: 'city', city: '<script>' })).statusCode).toBe(400);
    expect((await post({ slug: 'kid-lightbulbs', kind: 'city' })).statusCode).toBe(400);
    expect(tables.city_interest ?? []).toHaveLength(0);
  });
});

describe('GET — the fan’s own taps', () => {
  it('returns slugs, cities and the profile location, and nothing of other fans', async () => {
    tables.tip_interest = [{ artist_id: 'a-1', user_id: 'fan-1' }, { artist_id: 'a-2', user_id: 'fan-2' }];
    tables.city_interest = [{ artist_id: 'a-2', user_id: 'fan-1', city_key: 'leeds', city_label: 'Leeds' }];
    tables.usernames = [{ user_id: 'fan-1', location: 'Leeds, UK' }];
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      tip: ['kid-lightbulbs'],
      cities: { 'big-thief': 'Leeds' },
      defaultCity: 'Leeds, UK',
    });
  });
});

describe('GET ?view=dashboard', () => {
  it('serves the full counts to the owner of a verified claim', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: true, status: 200, artistId: 'a-1' });
    mocks.getArtistInterestCounts.mockResolvedValue(new Map([
      ['kid-lightbulbs', { tipCount: 2, cities: [{ label: 'Boston', count: 1 }] }],
    ]));
    const res = await get({ slug: 'kid-lightbulbs', view: 'dashboard' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ tipCount: 2, cities: [{ label: 'Boston', count: 1 }] });
    expect(mocks.resolveOwnedArtist).toHaveBeenCalledWith('kid-lightbulbs', 'fan-1');
    expect(mocks.getArtistInterestCounts).toHaveBeenCalledWith(['kid-lightbulbs'], { min: 1, limit: 10 });
  });

  it('refuses anyone else, before reading a single count', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: false, status: 403, error: 'You do not own this profile' });
    const res = await get({ slug: 'kid-lightbulbs', view: 'dashboard' });
    expect(res.statusCode).toBe(403);
    expect(mocks.getArtistInterestCounts).not.toHaveBeenCalled();
  });

  it('says the counts are unavailable rather than zero when the read fails', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: true, status: 200, artistId: 'a-1' });
    mocks.getArtistInterestCounts.mockResolvedValue(null);
    const res = await get({ slug: 'kid-lightbulbs', view: 'dashboard' });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET ?suggest=', () => {
  it('looks suggestions up by key', async () => {
    mocks.getCitySuggestions.mockResolvedValue(['Boston']);
    const res = await get({ suggest: 'BOS' });
    expect(JSON.parse(res.body)).toEqual({ suggestions: ['Boston'] });
    expect(mocks.getCitySuggestions).toHaveBeenCalledWith('bos');
  });

  it('skips the lookup for a single character', async () => {
    const res = await get({ suggest: 'b' });
    expect(JSON.parse(res.body)).toEqual({ suggestions: [] });
    expect(mocks.getCitySuggestions).not.toHaveBeenCalled();
  });
});
