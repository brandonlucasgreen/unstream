// /api/artist-campaigns: who may use it, what it proposes, and what it refuses to store
// (api/functions/artist-campaigns.ts). The database and Buffer are mocked; the proposal, the
// planner and the template language are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class BufferNotConnectedError extends Error {}
  return {
    BufferNotConnectedError,
    resolveAccountRequest: vi.fn(),
    canUseReleaseAutopost: vi.fn(),
    getAutopostArtist: vi.fn(),
    getAutopostReleases: vi.fn(),
    getAutopostSettings: vi.fn(),
    getAutopostHistory: vi.fn(),
    listAssets: vi.fn(),
    listCampaigns: vi.fn(),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    cancelCampaign: vi.fn(),
    usableAccessToken: vi.fn(),
    listChannels: vi.fn(),
  };
});

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../release-autopost-access', () => ({ canUseReleaseAutopost: mocks.canUseReleaseAutopost }));
vi.mock('../release-autopost-db', () => ({
  getAutopostArtist: mocks.getAutopostArtist,
  getAutopostReleases: mocks.getAutopostReleases,
  getAutopostSettings: mocks.getAutopostSettings,
  getAutopostHistory: mocks.getAutopostHistory,
  MAX_ATTEMPTS: 3,
}));
vi.mock('../promote-assets-db', () => ({ listAssets: mocks.listAssets }));
vi.mock('../release-campaigns-db', async importOriginal => ({
  ...(await importOriginal<typeof import('../release-campaigns-db')>()),
  listCampaigns: mocks.listCampaigns,
  createCampaign: mocks.createCampaign,
  updateCampaign: mocks.updateCampaign,
  cancelCampaign: mocks.cancelCampaign,
}));
vi.mock('../buffer-db', () => ({ BufferNotConnectedError: mocks.BufferNotConnectedError, usableAccessToken: mocks.usableAccessToken }));
vi.mock('../buffer-client', () => ({ listChannels: mocks.listChannels }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() }, withSentry: (h: unknown) => h }));

const { handler } = await import('../artist-campaigns');

type Res = { statusCode: number; body: string };
const call = (method: string, query: Record<string, string> = {}, body?: unknown) =>
  handler({
    httpMethod: method,
    headers: { authorization: 'Bearer t' },
    queryStringParameters: { artist: 'kid-lightbulbs', ...query },
    body: body === undefined ? null : JSON.stringify(body),
  }) as Promise<Res>;
const json = (r: Res) => JSON.parse(r.body);

const settings = {
  artistId: 'artist-1', userId: 'user-1', enabled: true, enabledAt: '2026-10-01T00:00:00Z', postsPerWeek: 1,
  timezone: 'America/New_York', postTime: '10:00', organizationId: 'org-1', channelIds: ['bsky', 'ig'],
  kindsOff: [], templates: null, pausedReason: null,
};

const release = {
  id: 'r1', slug: 'luminaires', title: 'Luminaires', releaseType: 'album', releaseDate: '2026-12-04', datePrecision: 'day',
  status: 'announced', createdAt: '2026-10-20T00:00:00Z', artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg', note: null,
  sources: [{ platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com/album/luminaires', offers: [] }],
};

const post = (over: Record<string, unknown> = {}) => ({ step: 'announce', date: '2026-11-06', text: '{title} comes out {date}. {link}', imageKey: 'cover', ...over });

describe('/api/artist-campaigns', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T17:00:00Z'));
    for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:user-1', user: { userId: 'user-1', email: 'admin@example.com' } });
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: 'https://f4.bcbits.com/img/p.jpg', verifiedOwnerId: 'user-1' });
    mocks.getAutopostReleases.mockResolvedValue([release]);
    mocks.getAutopostSettings.mockResolvedValue(settings);
    mocks.getAutopostHistory.mockResolvedValue([]);
    mocks.listAssets.mockResolvedValue([]);
    mocks.listCampaigns.mockResolvedValue([]);
    mocks.createCampaign.mockResolvedValue('c-1');
    mocks.usableAccessToken.mockResolvedValue('token');
    mocks.listChannels.mockResolvedValue([
      { id: 'bsky', name: 'kid', service: 'bluesky', isDisconnected: false },
      { id: 'ig', name: 'kid', service: 'instagram', isDisconnected: false },
    ]);
  });

  afterEach(() => vi.useRealTimers());

  it('says nothing to anyone the gate excludes, and nothing about someone else’s artist', async () => {
    mocks.canUseReleaseAutopost.mockResolvedValue(false);
    expect(json(await call('GET'))).toEqual({ available: false });
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'K', photoUrl: null, verifiedOwnerId: 'someone-else' });
    expect((await call('GET')).statusCode).toBe(403);
  });

  it('lists releases, where posts go, and whether autopost is on', async () => {
    const page = json(await call('GET'));
    expect(page).toMatchObject({ available: true, today: '2026-11-02', services: ['bluesky', 'instagram'], autopostOn: true, campaigns: [] });
    expect(page.releases[0]).toMatchObject({ id: 'r1', title: 'Luminaires', onBandcamp: true });
  });

  it('proposes posts and the autopost days around them, without saving anything', async () => {
    const res = json(await call('POST', { action: 'propose' }, { releaseId: 'r1', releaseDate: '2026-12-04', startDate: '2026-11-06' }));
    expect(res.posts.map((p: { step: string }) => p.step)).toEqual(
      ['announce', 'story', 'credits', 'week_to_go', 'tomorrow', 'release_day', 'thank_you', 'icymi']);
    expect(res.posts[0].text).toMatch(/pre-order/);
    // Autopost's Fridays, minus the days around campaign posts.
    const autopostDays: string[] = res.autopost.map((a: { date: string }) => a.date);
    for (const p of res.posts) {
      for (const d of autopostDays) expect(Math.abs(Date.parse(d) - Date.parse(p.date))).toBeGreaterThan(86_400_000);
    }
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it('schedules a campaign of valid posts', async () => {
    const res = await call('POST', {}, { releaseId: 'r1', releaseDate: '2026-12-04', posts: [post(), post({ step: 'release_day', date: '2026-12-04' })] });
    expect(res.statusCode).toBe(200);
    expect(mocks.createCampaign).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'r1', releaseDate: '2026-12-04',
      posts: [
        { step: 'announce', postDate: '2026-11-06', text: '{title} comes out {date}. {link}', imageKey: 'cover' },
        { step: 'release_day', postDate: '2026-12-04', text: '{title} comes out {date}. {link}', imageKey: 'cover' },
      ],
    }));
  });

  it('refuses posts it couldn’t send, saying which and why', async () => {
    const res = await call('POST', {}, {
      releaseId: 'r1',
      releaseDate: '2026-12-04',
      posts: [
        post({ date: '2026-11-02' }),
        post({ date: '2026-11-10', text: '{title} {nope}' }),
        post({ date: '2026-11-12', text: 'x'.repeat(301) }),
        post({ date: '2026-11-14', imageKey: 'upload:gone' }),
        post({ date: '2026-11-16' }),
        post({ date: '2026-11-16' }),
      ],
    });
    expect(res.statusCode).toBe(400);
    const { problems } = json(res);
    expect(problems[0]).toEqual(['Choose a date from tomorrow on']);
    expect(problems[1]).toEqual(['Unknown variable {nope}']);
    expect(problems[2][0]).toMatch(/Too long for bluesky/);
    expect(problems[3]).toEqual(['That image isn’t available any more']);
    expect(problems[4]).toBeUndefined();
    expect(problems[5]).toEqual(['Another post in this campaign is on this day']);
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it('needs channels to post to before it schedules anything', async () => {
    mocks.getAutopostSettings.mockResolvedValue({ ...settings, channelIds: [] });
    const res = await call('POST', {}, { releaseId: 'r1', releaseDate: '2026-12-04', posts: [post()] });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/Autopost tab/);
  });

  it('keeps a post already in Buffer, and won’t put another on its day', async () => {
    mocks.listCampaigns.mockResolvedValue([{
      id: 'c-1', artistId: 'artist-1', userId: 'user-1', releaseId: 'r1', releaseDate: '2026-12-04', createdAt: '2026-11-01T00:00:00Z',
      posts: [{ id: 'p1', campaignId: 'c-1', artistId: 'artist-1', step: 'announce', postDate: '2026-11-04', text: 'x', imageKey: null,
        status: 'pushed', attempts: 1, slotAt: '2026-11-04T15:00:00Z', bufferPostIds: [], captions: {}, error: null }],
    }]);
    const res = await call('PUT', { id: 'c-1' }, { releaseDate: '2026-12-04', posts: [post({ date: '2026-11-04' })] });
    expect(json(res).problems[0]).toEqual(['Another post in this campaign is on this day']);
    const ok = await call('PUT', { id: 'c-1' }, { releaseDate: '2026-12-11', posts: [post({ date: '2026-11-20' })] });
    expect(ok.statusCode).toBe(200);
    expect(mocks.updateCampaign).toHaveBeenCalledWith('c-1', '2026-12-11', [expect.objectContaining({ postDate: '2026-11-20' })]);
  });

  it('stops only its own campaigns', async () => {
    expect((await call('DELETE', { id: 'not-mine' })).statusCode).toBe(404);
    expect(mocks.cancelCampaign).not.toHaveBeenCalled();
  });
});
