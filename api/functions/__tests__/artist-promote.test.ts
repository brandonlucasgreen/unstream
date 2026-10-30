// The Promote tab's endpoint (api/functions/artist-promote.ts): who gets in, and that nothing the
// browser sends is saved unless Buffer and the rules agree. The planner is the real one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class BufferNotConnectedError extends Error {}
  return {
    BufferNotConnectedError,
    resolveAccountRequest: vi.fn(),
    canUseReleaseAutopost: vi.fn(),
    getAutopostArtist: vi.fn(),
    getAutopostSettings: vi.fn(),
    saveAutopostSettings: vi.fn(),
    getAutopostReleases: vi.fn(),
    getAutopostHistory: vi.fn(),
    getAutopostSlotsSince: vi.fn(),
    listChannelPosts: vi.fn(),
    usableAccessToken: vi.fn(),
    listOrganizations: vi.fn(),
    listChannels: vi.fn(),
    getFeatureFlag: vi.fn(),
    getTipsLiveSlugs: vi.fn(),
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
  getAutopostSettings: mocks.getAutopostSettings,
  saveAutopostSettings: mocks.saveAutopostSettings,
  getAutopostReleases: mocks.getAutopostReleases,
  getAutopostHistory: mocks.getAutopostHistory,
  getAutopostSlotsSince: mocks.getAutopostSlotsSince,
  MAX_ATTEMPTS: 3,
}));
vi.mock('../buffer-db', () => ({ BufferNotConnectedError: mocks.BufferNotConnectedError, usableAccessToken: mocks.usableAccessToken }));
vi.mock('../buffer-client', () => ({
  listOrganizations: mocks.listOrganizations,
  listChannels: mocks.listChannels,
  listChannelPosts: mocks.listChannelPosts,
}));
vi.mock('../feature-flags', () => ({ getFeatureFlag: mocks.getFeatureFlag }));
vi.mock('../tips-db', () => ({ getTipsLiveSlugs: mocks.getTipsLiveSlugs }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() }, withSentry: (h: unknown) => h }));

const { handler } = await import('../artist-promote');

type Res = { statusCode: number; body: string };
const call = (method: string, body?: unknown, artist = 'kid-lightbulbs') =>
  handler({
    httpMethod: method,
    headers: { authorization: 'Bearer t' },
    queryStringParameters: { artist },
    body: body === undefined ? null : JSON.stringify(body),
  } as never) as Promise<Res>;
const json = (res: Res) => JSON.parse(res.body);

const release = {
  id: 'r1', slug: 'ruined-castle', title: 'Ruined Castle', releaseType: 'ep', releaseDate: '2024-12-06',
  datePrecision: 'day', status: 'released', createdAt: '2026-01-01T00:00:00Z',
  artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg', note: null,
  sources: [{ platform: 'bandcamp', url: 'https://kid.bandcamp.com/album/ruined-castle', offers: [] }],
};

const validBody = {
  enabled: true,
  postsPerWeek: null,
  timezone: 'America/New_York',
  postTime: '10:00',
  organizationId: 'org_mine',
  channelIds: ['bsky', 'yt'],
  kindsOff: ['support'],
  templates: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:u1', user: { userId: 'u1', email: 'admin@example.com' } });
  mocks.canUseReleaseAutopost.mockResolvedValue(true);
  mocks.getAutopostArtist.mockResolvedValue({ id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: null, verifiedOwnerId: 'u1' });
  mocks.getAutopostSettings.mockResolvedValue(null);
  mocks.getAutopostReleases.mockResolvedValue([release]);
  mocks.getAutopostHistory.mockResolvedValue([]);
  mocks.getAutopostSlotsSince.mockResolvedValue([]);
  mocks.listChannelPosts.mockResolvedValue({ posts: [], complete: true });
  mocks.usableAccessToken.mockResolvedValue('token');
  mocks.listOrganizations.mockResolvedValue([{ id: 'org_mine', name: 'Cult of Lightbulbs' }]);
  mocks.listChannels.mockResolvedValue([
    { id: 'bsky', name: 'kid', service: 'bluesky', type: 'profile', serviceId: '1', isDisconnected: false },
    { id: 'yt', name: 'kid', service: 'youtube', type: 'channel', serviceId: '2', isDisconnected: false },
  ]);
  mocks.getFeatureFlag.mockResolvedValue(false);
});

afterEach(() => vi.useRealTimers());

describe('who gets in', () => {
  it('says nothing to an account the feature gate refuses', async () => {
    mocks.canUseReleaseAutopost.mockResolvedValue(false);
    expect(json(await call('GET'))).toEqual({ available: false });
    expect(mocks.getAutopostArtist).not.toHaveBeenCalled();
  });

  it('refuses anyone but the artist’s verified owner', async () => {
    mocks.getAutopostArtist.mockResolvedValue({ id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: null, verifiedOwnerId: 'someone-else' });
    expect((await call('GET')).statusCode).toBe(403);
    expect((await call('PUT', validBody)).statusCode).toBe(403);
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('needs a signed-in account', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:x', user: null });
    expect((await call('GET')).statusCode).toBe(401);
  });
});

describe('GET', () => {
  it('starts a new artist from off, recommended, and shows what switching on would post', async () => {
    const page = json(await call('GET'));
    expect(page).toMatchObject({
      available: true,
      saved: false,
      settings: { enabled: false, postsPerWeek: null, postTime: null, kindsOff: [], templates: null },
      releaseCount: 1,
      recommendedPerWeek: 1,
      buffer: { connected: true, organizations: [{ id: 'org_mine', name: 'Cult of Lightbulbs' }] },
    });
    expect(page.comingUp[0]).toMatchObject({
      date: '2026-11-13',
      kind: 'catalogue',
      release: { title: 'Ruined Castle', slug: 'ruined-castle' },
      imageUrl: release.artworkUrl,
      text: expect.stringContaining('https://unstream.stream/a/kid-lightbulbs/ruined-castle'),
    });
  });

  it('marks which channels autopost can write for', async () => {
    mocks.getAutopostSettings.mockResolvedValue({ ...validBody, artistId: 'a1', userId: 'u1', enabledAt: '2026-11-01T00:00:00Z', kindsOff: [], pausedReason: null });
    const page = json(await call('GET'));
    expect(page.buffer.channels).toEqual([
      { id: 'bsky', name: 'kid', service: 'bluesky', supported: true },
      { id: 'yt', name: 'kid', service: 'youtube', supported: false },
    ]);
  });

  it('shows Buffer as not connected rather than failing', async () => {
    mocks.usableAccessToken.mockRejectedValue(new mocks.BufferNotConnectedError());
    expect(json(await call('GET')).buffer).toEqual({ connected: false });
  });

  it('doesn’t hand a new owner the previous owner’s settings', async () => {
    mocks.getAutopostSettings.mockResolvedValue({ ...validBody, artistId: 'a1', userId: 'old-owner', enabledAt: '2026-11-01T00:00:00Z', kindsOff: [], pausedReason: null });
    expect(json(await call('GET')).settings).toMatchObject({ enabled: false, organizationId: null });
  });
});

describe('where each post stands', () => {
  const settings = { ...validBody, artistId: 'a1', userId: 'u1', enabledAt: '2026-11-01T00:00:00Z', kindsOff: [], pausedReason: null };
  const pushed = {
    slotAt: '2026-11-12T15:00:00.000Z', slotDate: '2026-11-12', kind: 'catalogue', releaseId: 'r1', templateIndex: 0,
    imageKey: 'cover:r1', imageOnInstagram: true, status: 'pushed', attempts: 1,
    error: 'threads: every posting time in its Buffer schedule on 2026-11-12 has passed',
    bufferPostIds: [{ channelId: 'bsky', postId: 'p1' }],
    captions: { bsky: { service: 'bluesky', text: 'What was actually sent', imageUrl: 'https://cards.unstream.stream/autopost/x.jpg' } },
  };

  beforeEach(() => mocks.getAutopostSettings.mockResolvedValue(settings));

  it('shows a post in Buffer with what was sent and Buffer’s own status for each channel', async () => {
    mocks.getAutopostSlotsSince.mockResolvedValue([pushed]);
    mocks.listChannelPosts.mockResolvedValue({
      posts: [{ id: 'p1', channelId: 'bsky', status: 'scheduled', dueAt: '2026-11-12T15:00:00.000Z', sentAt: null, externalLink: null, error: null }],
      complete: true,
    });
    const page = json(await call('GET'));
    expect(page.comingUp[0]).toMatchObject({
      date: '2026-11-12',
      text: 'What was actually sent',
      imageUrl: 'https://cards.unstream.stream/autopost/x.jpg',
      state: {
        is: 'in_buffer',
        skipped: pushed.error,
        channels: [{ channelId: 'bsky', service: 'bluesky', status: 'scheduled', dueAt: '2026-11-12T15:00:00.000Z' }],
      },
    });
    // The channels the posts went to, created since three days before "Recent" begins (its
    // first day's midnight in the artist's timezone).
    expect(mocks.listChannelPosts).toHaveBeenCalledWith('token', 'org_mine', ['bsky'], '2026-10-25T04:00:00.000Z');
  });

  it('reads the Buffer token once, however many Buffer reads the page makes', async () => {
    mocks.getAutopostSlotsSince.mockResolvedValue([pushed]);
    await call('GET');
    expect(mocks.usableAccessToken).toHaveBeenCalledTimes(1);
  });

  it('doesn’t ask Buffer about posts when none are in it', async () => {
    await call('GET');
    expect(mocks.listChannelPosts).not.toHaveBeenCalled();
  });

  it('still shows the page when Buffer can’t say where posts stand', async () => {
    mocks.getAutopostSlotsSince.mockResolvedValue([pushed]);
    mocks.listChannelPosts.mockRejectedValue(new Error('Buffer 503'));
    const page = json(await call('GET'));
    expect(page.comingUp[0].state.channels[0].status).toBe('unknown');
  });

  it('answers the poll with only the schedule, without asking Buffer for organizations or channels', async () => {
    mocks.getAutopostSlotsSince.mockResolvedValue([{ ...pushed, slotAt: '2026-11-05T15:00:00.000Z', slotDate: '2026-11-05' }]);
    const res = await handler({
      httpMethod: 'GET',
      headers: { authorization: 'Bearer t' },
      queryStringParameters: { artist: 'kid-lightbulbs', part: 'schedule' },
      body: null,
    } as never) as Res;
    const body = json(res);
    expect(Object.keys(body).sort()).toEqual(['comingUp', 'pausedReason', 'recent', 'today']);
    expect(body.recent[0]).toMatchObject({ date: '2026-11-05', state: { is: 'in_buffer' } });
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
    expect(mocks.listChannels).not.toHaveBeenCalled();
  });
});

describe('PUT', () => {
  it('saves only channels the organization has and autopost writes for, and starts the clock', async () => {
    const res = await call('PUT', validBody);
    expect(res.statusCode).toBe(200);
    expect(mocks.saveAutopostSettings).toHaveBeenCalledWith(expect.objectContaining({
      artistId: 'a1', userId: 'u1', enabled: true, organizationId: 'org_mine',
      channelIds: ['bsky'], kindsOff: ['support'], enabledAt: '2026-11-11T12:00:00.000Z', pausedReason: null,
    }));
  });

  it('accepts the Recommended posting time, which is Buffer’s queue', async () => {
    expect((await call('PUT', { ...validBody, postTime: null })).statusCode).toBe(200);
    expect(mocks.saveAutopostSettings).toHaveBeenCalledWith(expect.objectContaining({ postTime: null }));
  });

  it('keeps the original switch-on time when saving while on', async () => {
    mocks.getAutopostSettings.mockResolvedValue({ ...validBody, artistId: 'a1', userId: 'u1', enabledAt: '2026-11-01T00:00:00Z', kindsOff: [], pausedReason: 'buffer_disconnected' });
    await call('PUT', validBody);
    expect(mocks.saveAutopostSettings).toHaveBeenCalledWith(expect.objectContaining({ enabledAt: '2026-11-01T00:00:00Z', pausedReason: null }));
  });

  it('refuses to switch on without a channel', async () => {
    mocks.listChannels.mockResolvedValue([]);
    const res = await call('PUT', validBody);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/at least one channel/);
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('refuses an organization the Buffer account doesn’t belong to', async () => {
    expect((await call('PUT', { ...validBody, organizationId: 'org_someone_else' })).statusCode).toBe(400);
  });

  it('refuses bad values', async () => {
    for (const bad of [
      { postsPerWeek: 8 },
      { postTime: '25:00' },
      { timezone: 'Mars/Olympus' },
      { kindsOff: ['daily'] },
      { enabled: 'yes' },
    ]) {
      expect((await call('PUT', { ...validBody, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('says which templates need fixing, and saves none of them', async () => {
    const res = await call('PUT', { ...validBody, templates: { catalogue: ['{titel} is out'], support: ['Fine: {link}'] } });
    expect(res.statusCode).toBe(400);
    expect(json(res).problems).toEqual({ catalogue: ['Unknown variable {titel}'] });
    expect(mocks.saveAutopostSettings).not.toHaveBeenCalled();
  });

  it('stores the artist’s own variants, dropping blanks, and nothing for kinds left to the defaults', async () => {
    await call('PUT', { ...validBody, templates: { catalogue: ['{title}: {link}', '  '], support: [] } });
    expect(mocks.saveAutopostSettings).toHaveBeenCalledWith(expect.objectContaining({ templates: { catalogue: ['{title}: {link}'] } }));
  });
});
