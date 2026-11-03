// /api/artist-promote/assets: the asset library (api/functions/artist-promote-assets.ts). The
// database and R2 are mocked; the image sniffing is the real one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccountRequest: vi.fn(),
  canUseReleaseAutopost: vi.fn(),
  getAutopostArtist: vi.fn(),
  listAssets: vi.fn(),
  addAsset: vi.fn(),
  removeAsset: vi.fn(),
  storeImageBytes: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../release-autopost-access', () => ({ canUseReleaseAutopost: mocks.canUseReleaseAutopost }));
vi.mock('../release-autopost-db', () => ({ getAutopostArtist: mocks.getAutopostArtist }));
vi.mock('../promote-assets-db', () => ({
  listAssets: mocks.listAssets, addAsset: mocks.addAsset, removeAsset: mocks.removeAsset, MAX_ASSETS: 12,
}));
vi.mock('../autopost-media', async importOriginal => ({
  ...(await importOriginal<typeof import('../autopost-media')>()),
  storeImageBytes: mocks.storeImageBytes,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() }, withSentry: (h: unknown) => h }));

const { handler } = await import('../artist-promote-assets');

type Res = { statusCode: number; body: string };
const call = (method: string, query: Record<string, string> = {}, body?: unknown) =>
  handler({
    httpMethod: method,
    headers: { authorization: 'Bearer t' },
    queryStringParameters: { artist: 'kid-lightbulbs', ...query },
    body: body === undefined ? null : JSON.stringify(body),
  }) as Promise<Res>;

const BUCKET_ENV = {
  SOCIAL_CARDS_BUCKET: 'b', SOCIAL_CARDS_PUBLIC_BASE_URL: 'https://cards.unstream.stream', R2_ACCOUNT_ID: 'a',
  SOCIAL_CARDS_R2_ACCESS_KEY_ID: 'k', SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: 's',
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');
const asset = (id: string, width = 1080, height = 1080) => ({ id, url: `https://cards.unstream.stream/promote/a/${id}.jpg`, storageKey: `promote/a/${id}.jpg`, width, height, createdAt: '' });

describe('/api/artist-promote/assets', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    Object.assign(process.env, BUCKET_ENV);
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:user-1', user: { userId: 'user-1', email: 'a@example.com' } });
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'K', photoUrl: null, verifiedOwnerId: 'user-1' });
    mocks.listAssets.mockResolvedValue([]);
    mocks.storeImageBytes.mockResolvedValue({ key: 'promote/artist-1/h.jpg', url: 'https://cards.unstream.stream/promote/artist-1/h.jpg', contentType: 'image/jpeg', width: 2048, height: 1024 });
  });
  afterEach(() => { process.env = { ...savedEnv }; });

  it('lists the library, saying which images Instagram can’t take', async () => {
    mocks.listAssets.mockResolvedValue([asset('square'), asset('wide', 3000, 1000)]);
    const body = JSON.parse((await call('GET')).body);
    expect(body.assets.map((a: { id: string; instagramOk: boolean }) => [a.id, a.instagramOk])).toEqual([['square', true], ['wide', false]]);
  });

  it('stores an upload under the artist’s own prefix and records it', async () => {
    const res = await call('POST', {}, { data: JPEG });
    expect(res.statusCode).toBe(200);
    expect(mocks.storeImageBytes).toHaveBeenCalledWith(expect.anything(), expect.any(Uint8Array), 'promote/artist-1');
    expect(mocks.addAsset).toHaveBeenCalledWith(expect.objectContaining({ artistId: 'artist-1', userId: 'user-1', storageKey: 'promote/artist-1/h.jpg', byteSize: 6 }));
  });

  it('refuses what isn’t a JPEG or PNG, plainly', async () => {
    mocks.storeImageBytes.mockRejectedValue(new Error('image is not a JPEG or PNG'));
    const res = await call('POST', {}, { data: Buffer.from('GIF89a').toString('base64') });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/JPEG and PNG/);
    expect(mocks.addAsset).not.toHaveBeenCalled();
  });

  it('holds twelve at most', async () => {
    mocks.listAssets.mockResolvedValue(Array.from({ length: 12 }, (_, i) => asset(`a${i}`)));
    const res = await call('POST', {}, { data: JPEG });
    expect(res.statusCode).toBe(400);
    expect(mocks.storeImageBytes).not.toHaveBeenCalled();
  });

  it('removes only the artist’s own images', async () => {
    mocks.removeAsset.mockResolvedValue(false);
    expect((await call('DELETE', { id: 'x' })).statusCode).toBe(404);
    expect(mocks.removeAsset).toHaveBeenCalledWith(expect.anything(), 'artist-1', 'x', expect.any(Date));
  });

  it('says uploads aren’t available when the bucket isn’t configured', async () => {
    delete process.env.SOCIAL_CARDS_BUCKET;
    expect((await call('POST', {}, { data: JPEG })).statusCode).toBe(503);
  });

  it('refuses another owner', async () => {
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'K', photoUrl: null, verifiedOwnerId: 'other' });
    expect((await call('GET')).statusCode).toBe(403);
  });
});
