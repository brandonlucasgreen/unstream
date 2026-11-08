// GET /api/me/artist-nav — the header's artist menu. Locked here: a fan gets no artists and costs
// no flag reads; an artist's Tips and Promote come from the same gates their own endpoints use,
// so a non-admin sees them once the flags are on (the rule after the 2026-11-05 Promote incident).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({
  resolveAccountRequest: vi.fn(),
  tipsOpenToArtist: vi.fn(),
  canUseReleaseAutopost: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => db.client }));
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '203.0.113.7',
}));
vi.mock('../tips-db', () => ({ tipsOpenToArtist: mocks.tipsOpenToArtist }));
vi.mock('../release-autopost-access', () => ({ canUseReleaseAutopost: mocks.canUseReleaseAutopost }));
vi.mock('../../lib/sentry', () => ({ withSentry: (h: unknown) => h, Sentry: { captureException: vi.fn() } }));

import { handler } from '../me-artist-nav';

const get = async () => {
  const res = await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer t' } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

beforeEach(() => {
  db = createFakeDb();
  vi.clearAllMocks();
  mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:fan', user: { userId: 'u1', email: 'artist@example.com' } });
});

describe('me-artist-nav', () => {
  it('needs a signed-in account', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:x', user: null });
    expect((await get()).status).toBe(401);
  });

  it('answers a fan with no artists, without reading any flag', async () => {
    db.tables.artist_profiles = [];
    expect((await get()).body).toEqual({ artists: [], tips: false, promote: false });
    expect(mocks.tipsOpenToArtist).not.toHaveBeenCalled();
    expect(mocks.canUseReleaseAutopost).not.toHaveBeenCalled();
  });

  it("lists only this account's verified artists", async () => {
    db.tables.artist_profiles = [
      { user_id: 'u1', verified_at: '2026-01-01', artists: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' } },
      { user_id: 'u1', verified_at: null, artists: { name: 'Pending', slug: 'pending' } },
      { user_id: 'u2', verified_at: '2026-01-01', artists: { name: 'Someone Else', slug: 'someone-else' } },
    ];
    mocks.tipsOpenToArtist.mockResolvedValue(false);
    mocks.canUseReleaseAutopost.mockResolvedValue(false);
    expect((await get()).body.artists).toEqual([{ name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }]);
  });

  it("shows Tips and Promote to a non-admin artist once the gates say yes", async () => {
    db.tables.artist_profiles = [
      { user_id: 'u1', verified_at: '2026-01-01', artists: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' } },
    ];
    mocks.tipsOpenToArtist.mockResolvedValue(true);
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    const { body } = await get();
    expect(body).toMatchObject({ tips: true, promote: true });
    expect(mocks.tipsOpenToArtist).toHaveBeenCalledWith('artist@example.com');
    expect(mocks.canUseReleaseAutopost).toHaveBeenCalledWith('artist@example.com');
  });
});
