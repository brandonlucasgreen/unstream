// /api/artist-campaigns: who may use it, what it proposes, and what it refuses to store
// (api/functions/artist-campaigns.ts). The database and Buffer are mocked; the proposal, the
// planner and the template language are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class BufferNotConnectedError extends Error {}
  return {
    BufferNotConnectedError,
    resolveAccountRequest: vi.fn(),
    sessionMissingSecondFactor: vi.fn(),
    canUseReleaseAutopost: vi.fn(),
    getAutopostArtist: vi.fn(),
    getAutopostReleases: vi.fn(),
    getAutopostSettings: vi.fn(),
    saveAutopostSettings: vi.fn(),
    getAutopostHistory: vi.fn(),
    listAssets: vi.fn(),
    listCampaigns: vi.fn(),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    cancelCampaign: vi.fn(),
    usableAccessToken: vi.fn(),
    listOrganizations: vi.fn(),
    listChannels: vi.fn(),
  };
});

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  sessionMissingSecondFactor: mocks.sessionMissingSecondFactor,
}));
vi.mock('../release-autopost-access', () => ({ canUseReleaseAutopost: mocks.canUseReleaseAutopost }));
vi.mock('../release-autopost-db', async importOriginal => ({
  // The real one: what an artist who starts on this tab gets a settings row of.
  defaultAutopostSettings: (await importOriginal<typeof import('../release-autopost-db')>()).defaultAutopostSettings,
  getAutopostArtist: mocks.getAutopostArtist,
  getAutopostReleases: mocks.getAutopostReleases,
  getAutopostSettings: mocks.getAutopostSettings,
  saveAutopostSettings: mocks.saveAutopostSettings,
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
vi.mock('../buffer-client', () => ({ listOrganizations: mocks.listOrganizations, listChannels: mocks.listChannels }));
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
/** A campaign body: its own channels, which are not autopost's unless it says so. */
const body = (over: Record<string, unknown> = {}) => ({ releaseId: 'r1', releaseDate: '2026-12-04', channelIds: ['bsky', 'ig'], posts: [post()], ...over });

describe('/api/artist-campaigns', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T17:00:00Z'));
    for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:user-1', user: { userId: 'user-1', email: 'admin@example.com' } });
    mocks.sessionMissingSecondFactor.mockResolvedValue(false);
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: 'https://f4.bcbits.com/img/p.jpg', verifiedOwnerId: 'user-1' });
    mocks.getAutopostReleases.mockResolvedValue([release]);
    mocks.getAutopostSettings.mockResolvedValue(settings);
    mocks.getAutopostHistory.mockResolvedValue([]);
    mocks.listAssets.mockResolvedValue([]);
    mocks.listCampaigns.mockResolvedValue([]);
    mocks.createCampaign.mockResolvedValue('c-1');
    mocks.usableAccessToken.mockResolvedValue('token');
    mocks.listOrganizations.mockResolvedValue([{ id: 'org-1', name: 'Kid Lightbulbs' }]);
    mocks.listChannels.mockResolvedValue([
      { id: 'bsky', name: 'kid', service: 'bluesky', isDisconnected: false },
      { id: 'ig', name: 'kid', service: 'instagram', isDisconnected: false },
      { id: 'th', name: 'kid', service: 'threads', isDisconnected: false },
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

  it('refuses a sign-in that hasn’t finished its second step', async () => {
    mocks.sessionMissingSecondFactor.mockResolvedValue(true);
    expect((await call('GET')).statusCode).toBe(403);
    expect((await call('POST', {}, body())).statusCode).toBe(403);
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it('lists releases, the artist’s Buffer and whether autopost is on', async () => {
    const page = json(await call('GET'));
    expect(page).toMatchObject({ available: true, today: '2026-11-02', autopostOn: true, campaigns: [] });
    expect(page.buffer).toMatchObject({ connected: true, organizationId: 'org-1' });
    expect(page.buffer.channels.map((c: { id: string }) => c.id)).toEqual(['bsky', 'ig', 'th']);
    // A new campaign starts from autopost's channels, not from every channel they have.
    expect(page.defaultChannelIds).toEqual(['bsky', 'ig']);
    expect(page.releases[0]).toMatchObject({ id: 'r1', title: 'Luminaires', onBandcamp: true });
  });

  it('looks at another Buffer organization when asked, without saving anything', async () => {
    mocks.listOrganizations.mockResolvedValue([{ id: 'org-1', name: 'Kid' }, { id: 'org-2', name: 'The label' }]);
    const page = json(await call('GET', { organizationId: 'org-2' }));
    expect(page.buffer.organizationId).toBe('org-2');
    expect(mocks.listChannels).toHaveBeenCalledWith('token', 'org-2');
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('offers every channel for a first campaign when autopost has none', async () => {
    mocks.getAutopostSettings.mockResolvedValue(null);
    expect(json(await call('GET')).defaultChannelIds).toEqual(['bsky', 'ig', 'th']);
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

  it('for a release already out, runs from tomorrow for the weeks chosen', async () => {
    mocks.getAutopostReleases.mockResolvedValue([{ ...release, releaseDate: '2025-10-23', status: 'released' }]);
    const res = json(await call('POST', { action: 'propose' }, { releaseId: 'r1', releaseDate: '2025-10-23', runWeeks: 2 }));
    expect(res.posts[0]).toMatchObject({ step: 'out_now', date: '2026-11-03' });
    expect(res.posts.at(-1).date <= '2026-11-16').toBe(true);
    for (const p of res.posts) expect(p.text).not.toMatch(/\bnew\b|pre-order/i);
  });

  it('schedules a campaign of valid posts, on the channels it chose', async () => {
    const res = await call('POST', {}, body({ posts: [post(), post({ step: 'release_day', date: '2026-12-04' })] }));
    expect(res.statusCode).toBe(200);
    expect(mocks.createCampaign).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'r1', releaseDate: '2026-12-04', channelIds: ['bsky', 'ig'],
      posts: [
        { step: 'announce', postDate: '2026-11-06', text: '{title} comes out {date}. {link}', imageKey: 'cover' },
        { step: 'release_day', postDate: '2026-12-04', text: '{title} comes out {date}. {link}', imageKey: 'cover' },
      ],
    }));
  });

  it('refuses posts it couldn’t send, saying which and why', async () => {
    const res = await call('POST', {}, body({
      posts: [
        post({ date: '2026-11-02' }),
        post({ date: '2026-11-10', text: '{title} {nope}' }),
        post({ date: '2026-11-12', text: 'x'.repeat(301) }),
        post({ date: '2026-11-14', imageKey: 'upload:gone' }),
        post({ date: '2026-11-16' }),
        post({ date: '2026-11-16' }),
      ],
    }));
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

  it('needs channels of its own, whatever autopost posts to', async () => {
    // Autopost's channels don't stand in for a campaign's: it says where it posts or it isn't saved.
    expect(json(await call('POST', {}, body({ channelIds: [] }))).error).toMatch(/at least one channel/);
    // Nor does a channel the artist doesn't have in Buffer.
    expect(json(await call('POST', {}, body({ channelIds: ['someone-elses'] }))).error).toMatch(/at least one channel/);
    expect(mocks.createCampaign).not.toHaveBeenCalled();

    mocks.usableAccessToken.mockRejectedValue(new mocks.BufferNotConnectedError('no connection'));
    expect(json(await call('POST', {}, body())).error).toMatch(/Connect Buffer/);
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it('checks each post against the networks this campaign posts to, not autopost’s', async () => {
    // 301 characters is over Bluesky's limit and inside Threads'.
    const long = post({ text: 'x'.repeat(301) });
    expect(json(await call('POST', {}, body({ channelIds: ['th'], posts: [long] }))).error).toBeUndefined();
    expect(mocks.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ['th'] }));
    expect(json(await call('POST', {}, body({ channelIds: ['bsky'], posts: [long] }))).problems[0][0]).toMatch(/Too long for bluesky/);
  });

  it('settles the Buffer organization for an artist who starts on this tab', async () => {
    mocks.getAutopostSettings.mockResolvedValue(null);
    expect((await call('POST', {}, body())).statusCode).toBe(200);
    // Autopost off, and the organization stored so the sweep knows where the channels live.
    expect(mocks.saveAutopostSettings).toHaveBeenCalledWith(expect.objectContaining({
      artistId: 'artist-1', userId: 'user-1', enabled: false, organizationId: 'org-1', channelIds: [],
    }));
  });

  it('doesn’t rewrite the organization an artist already has', async () => {
    expect((await call('POST', {}, body())).statusCode).toBe(200);
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('keeps a post already in Buffer, and won’t put another on its day', async () => {
    mocks.listCampaigns.mockResolvedValue([{
      id: 'c-1', artistId: 'artist-1', userId: 'user-1', releaseId: 'r1', releaseDate: '2026-12-04',
      channelIds: ['bsky'], createdAt: '2026-11-01T00:00:00Z',
      posts: [{ id: 'p1', campaignId: 'c-1', artistId: 'artist-1', step: 'announce', postDate: '2026-11-04', text: 'x', imageKey: null,
        status: 'pushed', attempts: 1, slotAt: '2026-11-04T15:00:00Z', bufferPostIds: [], captions: {}, error: null }],
    }]);
    const res = await call('PUT', { id: 'c-1' }, body({ posts: [post({ date: '2026-11-04' })] }));
    expect(json(res).problems[0]).toEqual(['Another post in this campaign is on this day']);
    const ok = await call('PUT', { id: 'c-1' }, body({ releaseDate: '2026-12-11', channelIds: ['th'], posts: [post({ date: '2026-11-20' })] }));
    expect(ok.statusCode).toBe(200);
    expect(mocks.updateCampaign).toHaveBeenCalledWith('c-1', '2026-12-11', ['th'], [expect.objectContaining({ postDate: '2026-11-20' })]);
  });

  it('stops only its own campaigns', async () => {
    expect((await call('DELETE', { id: 'not-mine' })).statusCode).toBe(404);
    expect(mocks.cancelCampaign).not.toHaveBeenCalled();
  });
});
