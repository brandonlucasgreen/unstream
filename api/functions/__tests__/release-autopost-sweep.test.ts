// The release autopost sweep: who it posts for, what reaches Buffer, and that nothing posts twice
// (api/functions/release-autopost-sweep.ts). The database, Buffer and R2 are mocked; the planner
// and the per-channel rules are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class BufferNotConnectedError extends Error {}
  return {
    BufferNotConnectedError,
    getActiveAutopostSettings: vi.fn(),
    getAutopostArtist: vi.fn(),
    getAutopostReleases: vi.fn(),
    getAutopostHistory: vi.fn(),
    getUserEmail: vi.fn(),
    claimSlot: vi.fn(),
    finishSlot: vi.fn(),
    pauseAutopost: vi.fn(),
    canUseReleaseAutopost: vi.fn(),
    usableAccessToken: vi.fn(),
    listChannels: vi.fn(),
    ensureTag: vi.fn(),
    createPost: vi.fn(),
    getFeatureFlag: vi.fn(),
    getTipsLiveSlugs: vi.fn(),
    storeImageFromUrl: vi.fn(),
  };
});

vi.mock('../release-autopost-db', () => ({
  getActiveAutopostSettings: mocks.getActiveAutopostSettings,
  getAutopostArtist: mocks.getAutopostArtist,
  getAutopostReleases: mocks.getAutopostReleases,
  getAutopostHistory: mocks.getAutopostHistory,
  getUserEmail: mocks.getUserEmail,
  claimSlot: mocks.claimSlot,
  finishSlot: mocks.finishSlot,
  pauseAutopost: mocks.pauseAutopost,
}));
vi.mock('../release-autopost-access', () => ({ canUseReleaseAutopost: mocks.canUseReleaseAutopost }));
vi.mock('../buffer-db', () => ({ BufferNotConnectedError: mocks.BufferNotConnectedError, usableAccessToken: mocks.usableAccessToken }));
vi.mock('../buffer-client', () => ({ listChannels: mocks.listChannels, ensureTag: mocks.ensureTag, createPost: mocks.createPost }));
vi.mock('../feature-flags', () => ({ getFeatureFlag: mocks.getFeatureFlag }));
vi.mock('../tips-db', () => ({ getTipsLiveSlugs: mocks.getTipsLiveSlugs }));
vi.mock('../autopost-media', async importOriginal => ({
  ...(await importOriginal<typeof import('../autopost-media')>()),
  storeImageFromUrl: mocks.storeImageFromUrl,
}));

const { handler } = await import('../release-autopost-sweep');

const SECRET = 'test-internal-secret';
const BUCKET_ENV = {
  SOCIAL_CARDS_BUCKET: 'unstream-social-cards',
  SOCIAL_CARDS_PUBLIC_BASE_URL: 'https://cards.unstream.stream',
  R2_ACCOUNT_ID: 'acct',
  SOCIAL_CARDS_R2_ACCESS_KEY_ID: 'key',
  SOCIAL_CARDS_R2_SECRET_ACCESS_KEY: 'secret',
};

const settings = {
  artistId: 'artist-1',
  userId: 'user-1',
  enabled: true,
  enabledAt: '2026-10-01T00:00:00Z',
  postsPerWeek: 1,
  timezone: 'America/New_York',
  postTime: '10:00',
  organizationId: 'org-1',
  channelIds: ['bsky', 'ig'],
  kindsOff: [],
  templates: null,
  pausedReason: null,
};

const release = {
  id: 'r1',
  slug: 'ruined-castle',
  title: 'Ruined Castle',
  releaseType: 'ep',
  releaseDate: '2024-12-06',
  datePrecision: 'day',
  status: 'released',
  createdAt: '2026-01-01T00:00:00Z',
  artworkUrl: 'https://f4.bcbits.com/img/a123_2.jpg',
  note: null,
  sources: [{ platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com/album/ruined-castle', offers: [] }],
};

const run = (over: { method?: string; auth?: string } = {}) =>
  handler({ httpMethod: over.method ?? 'POST', headers: { authorization: over.auth ?? `Bearer ${SECRET}` } }) as
    Promise<{ statusCode: number; body: string }>;

describe('release-autopost-sweep', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Wednesday 11 November, noon UTC: Friday's 10:00 New York slot is 51 hours away.
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    Object.assign(process.env, BUCKET_ENV, { INTERNAL_FUNCTION_SECRET: SECRET });
    for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();

    mocks.getActiveAutopostSettings.mockResolvedValue([settings]);
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: null, verifiedOwnerId: 'user-1' });
    mocks.getUserEmail.mockResolvedValue('admin@example.com');
    mocks.canUseReleaseAutopost.mockResolvedValue(true);
    mocks.getAutopostReleases.mockResolvedValue([release]);
    mocks.getAutopostHistory.mockResolvedValue([]);
    mocks.claimSlot.mockResolvedValue('slot-row-1');
    mocks.usableAccessToken.mockResolvedValue('token');
    mocks.listChannels.mockResolvedValue([
      { id: 'bsky', name: 'kid', service: 'bluesky', type: 'profile', serviceId: 'x', isDisconnected: false },
      { id: 'ig', name: 'kid', service: 'instagram', type: 'business', serviceId: 'y', isDisconnected: false },
      { id: 'other', name: 'not ticked', service: 'threads', type: 'profile', serviceId: 'z', isDisconnected: false },
    ]);
    mocks.ensureTag.mockResolvedValue('tag-1');
    mocks.getFeatureFlag.mockResolvedValue(false);
    mocks.storeImageFromUrl.mockResolvedValue({ url: 'https://cards.unstream.stream/autopost/abc.jpg', width: 1200, height: 1200 });
    mocks.createPost.mockImplementation(async (_token: string, input: { channelId: string }) => ({
      created: [{ id: `post-${input.channelId}`, status: 'scheduled', channelId: input.channelId }],
      errors: [],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
  });

  it('refuses anything but an internal POST', async () => {
    expect((await run({ method: 'GET' })).statusCode).toBe(405);
    expect((await run({ auth: 'Bearer wrong' })).statusCode).toBe(401);
    expect(mocks.getActiveAutopostSettings).not.toHaveBeenCalled();
  });

  it('refuses the whole run when the media bucket isn’t configured', async () => {
    delete process.env.SOCIAL_CARDS_BUCKET;
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('SOCIAL_CARDS_BUCKET');
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it('is a quiet no-op with nobody to post for, bucket or not', async () => {
    delete process.env.SOCIAL_CARDS_BUCKET;
    mocks.getActiveAutopostSettings.mockResolvedValue([]);
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ artists: 0, pushed: 0 });
  });

  it('pushes a due slot to every ticked channel, scheduled, tagged and with its cover', async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ artists: 1, pushed: 1, failed: 0, errors: 0 });

    expect(mocks.claimSlot).toHaveBeenCalledWith(expect.objectContaining({
      artistId: 'artist-1', slotAt: '2026-11-13T15:00:00.000Z', kind: 'catalogue', releaseId: 'r1',
    }));
    expect(mocks.storeImageFromUrl).toHaveBeenCalledWith(expect.anything(), release.artworkUrl);
    expect(mocks.createPost.mock.calls.map(c => c[1].channelId)).toEqual(['bsky', 'ig']);
    for (const [, input] of mocks.createPost.mock.calls) {
      expect(input).toMatchObject({ dueAt: '2026-11-13T15:00:00.000Z', mode: 'customScheduled', tagIds: ['tag-1'] });
    }
    expect(mocks.ensureTag).toHaveBeenCalledWith('token', 'org-1', 'unstream: release autopost', expect.any(String));
    expect(mocks.finishSlot).toHaveBeenCalledWith('slot-row-1', expect.objectContaining({
      status: 'pushed',
      bufferPostIds: [{ channelId: 'bsky', postId: 'post-bsky' }, { channelId: 'ig', postId: 'post-ig' }],
      error: null,
    }));
  });

  it('pushes nothing for a slot another run has already claimed', async () => {
    mocks.claimSlot.mockResolvedValue(null);
    await run();
    expect(mocks.createPost).not.toHaveBeenCalled();
    expect(mocks.finishSlot).not.toHaveBeenCalled();
  });

  it('touches nothing in Buffer when no post is due within 72 hours', async () => {
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    await run();
    expect(mocks.usableAccessToken).not.toHaveBeenCalled();
    expect(mocks.claimSlot).not.toHaveBeenCalled();
  });

  it('posts nothing for an owner the feature gate refuses', async () => {
    mocks.canUseReleaseAutopost.mockResolvedValue(false);
    const summary = JSON.parse((await run()).body);
    expect(summary.skipped).toEqual([{ artistId: 'artist-1', reason: 'not allowed by the releaseAutopost flag' }]);
    expect(mocks.claimSlot).not.toHaveBeenCalled();
  });

  it('posts nothing once the owner no longer holds the verified claim', async () => {
    mocks.getAutopostArtist.mockResolvedValue({ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', photoUrl: null, verifiedOwnerId: 'someone-else' });
    await run();
    expect(mocks.canUseReleaseAutopost).not.toHaveBeenCalled();
    expect(mocks.claimSlot).not.toHaveBeenCalled();
  });

  it('pauses an artist whose Buffer is disconnected', async () => {
    mocks.usableAccessToken.mockRejectedValue(new mocks.BufferNotConnectedError('gone'));
    await run();
    expect(mocks.pauseAutopost).toHaveBeenCalledWith('artist-1', 'buffer_disconnected');
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it('still posts to the other networks when the image can’t be copied, and says why Instagram didn’t', async () => {
    mocks.storeImageFromUrl.mockRejectedValue(new Error('image host returned 404'));
    await run();
    expect(mocks.createPost.mock.calls.map(c => c[1].channelId)).toEqual(['bsky']);
    expect(mocks.createPost.mock.calls[0][1].assets).toBeUndefined();
    const outcome = mocks.finishSlot.mock.calls[0][1];
    expect(outcome.status).toBe('pushed');
    expect(outcome.error).toContain('instagram:');
    expect(outcome.error).toContain('404');
  });

  it('records a slot as failed when no channel took it, so a later run retries it', async () => {
    mocks.createPost.mockResolvedValue({ created: [], errors: [{ message: 'Rate limited' }] });
    const summary = JSON.parse((await run()).body);
    expect(summary).toMatchObject({ pushed: 0, failed: 1 });
    expect(mocks.finishSlot).toHaveBeenCalledWith('slot-row-1', expect.objectContaining({ status: 'failed' }));
  });
});
