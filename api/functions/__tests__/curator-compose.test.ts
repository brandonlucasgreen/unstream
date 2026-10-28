// The curator compose endpoint: its gate, how it reads the action from the path, what preview
// reports, and the guard that stops a browser handing Buffer any URL to publish.
//
// curator-posts.ts is deliberately NOT mocked — the captions these assert on are rendered for
// real, so a change to the rendering rules shows up here too.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BufferNotConnectedError } from '../buffer-db';

const getArtistsBySlugs = vi.fn();
const getFeatureFlag = vi.fn();
const resolveAccountRequest = vi.fn();
const getBufferConnection = vi.fn();
const usableAccessToken = vi.fn();
const listChannels = vi.fn();
const ensureTag = vi.fn();
const createPost = vi.fn();
const createContentItem = vi.fn();
const addPostToContentItem = vi.fn();
const renderCuratorCard = vi.fn();
const publishCard = vi.fn();
const captureException = vi.fn();

vi.mock('../db', () => ({ getArtistsBySlugs: (...a: unknown[]) => getArtistsBySlugs(...a) }));

vi.mock('../feature-flags', () => ({ getFeatureFlag: (...a: unknown[]) => getFeatureFlag(...a) }));

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: (...a: unknown[]) => resolveAccountRequest(...a),
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));

vi.mock('../buffer-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-db')>()),
  getBufferConnection: (...a: unknown[]) => getBufferConnection(...a),
  usableAccessToken: (...a: unknown[]) => usableAccessToken(...a),
}));

vi.mock('../buffer-client', () => ({
  listChannels: (...a: unknown[]) => listChannels(...a),
  ensureTag: (...a: unknown[]) => ensureTag(...a),
  createPost: (...a: unknown[]) => createPost(...a),
  createContentItem: (...a: unknown[]) => createContentItem(...a),
  addPostToContentItem: (...a: unknown[]) => addPostToContentItem(...a),
}));

vi.mock('../../../scripts/social-card-render', () => ({
  renderCuratorCard: (...a: unknown[]) => renderCuratorCard(...a),
  // The module registers its CommonJS asset loader at import time, so the mock has to carry
  // both of these even though the drawing itself is stubbed.
  loadCardAssetsWith: () => {},
  CARD_FONT_FILES: ['a.ttf', 'b.ttf', 'c.ttf'],
}));

vi.mock('../../../scripts/social-cards', () => ({
  cardBucketFromEnv: () => ({
    name: 'unstream-social-cards',
    publicBaseUrl: 'https://cards.unstream.stream',
    accountId: 'acc', accessKeyId: 'k', secretAccessKey: 's',
  }),
  publishCard: (...a: unknown[]) => publishCard(...a),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: (...a: unknown[]) => captureException(...a), captureMessage: vi.fn() },
  withSentry: (h: unknown) => h,
}));

const { handler } = await import('../curator-compose');

const artistRow = (slug: string, name: string, over: Record<string, unknown> = {}) => ({
  id: `id-${slug}`, slug, name, type: 'artist' as const,
  platforms: [
    { sourceId: 'bandcamp', url: `https://${slug}.bandcamp.com`, latestRelease: { title: 'Luminaires', type: 'album' as const, url: 'x' } },
    { sourceId: 'instagram', url: `https://instagram.com/${slug}` },
  ],
  location: { city: 'Brooklyn' },
  ...over,
});

const call = (action: string, body: unknown, headers: Record<string, string> = { authorization: 'Bearer t' }) =>
  handler({
    httpMethod: 'POST',
    headers,
    rawUrl: `https://unstream.stream/api/curator/${action}`,
    body: JSON.stringify(body),
  } as never) as Promise<{ statusCode: number; body: string }>;

const json = (res: { body: string }) => JSON.parse(res.body);

const template = { postText: 'Tonight on {show}:\n\n{artists}\n\nBuy direct: {link}', lineText: '{artist} – {release}', hashtags: [] };
const curator = { showName: 'Night Shift', handles: { instagram: 'nightshift' } };
const baseBody = { artists: [{ slug: 'honeycrush' }], template, curator };

beforeEach(() => {
  vi.clearAllMocks();
  getFeatureFlag.mockResolvedValue(true);
  resolveAccountRequest.mockResolvedValue({ key: 'user:user-1', user: { userId: 'user-1', email: 'curator@example.com' } });
  getBufferConnection.mockResolvedValue({ organizationId: 'org_1', selectedChannelIds: [], refreshCounter: 0 });
  usableAccessToken.mockResolvedValue('curator-token');
  getArtistsBySlugs.mockResolvedValue(new Map([['honeycrush', artistRow('honeycrush', 'Honeycrush')]]));
});

afterEach(() => { vi.clearAllMocks(); });

describe('the gate', () => {
  it('refuses anyone not signed in', async () => {
    resolveAccountRequest.mockResolvedValue({ key: 'ip:127.0.0.1', user: null });
    const res = await call('preview', baseBody);
    expect(res.statusCode).toBe(401);
    expect(getArtistsBySlugs).not.toHaveBeenCalled();
  });

  // Fails closed, like the store it reads: an unset flag hides the feature rather than
  // half-opening it.
  it('reports itself unavailable when the flag is off, before touching anything', async () => {
    getFeatureFlag.mockResolvedValue(false);
    expect(json(await call('preview', baseBody))).toEqual({ available: false });
    expect(resolveAccountRequest).not.toHaveBeenCalled();
    expect(getArtistsBySlugs).not.toHaveBeenCalled();
  });

  // Not an error: the page offers to connect. Every curator posts from their own account.
  it('reports not-connected when this curator has no Buffer connection', async () => {
    getBufferConnection.mockResolvedValue(null);
    expect(json(await call('preview', baseBody))).toEqual({ available: true, connected: false });
  });

  it('asks them to reconnect when Buffer has revoked the grant', async () => {
    usableAccessToken.mockRejectedValue(new BufferNotConnectedError('Buffer refused the connection. Reconnect to continue.'));
    const data = json(await call('send', { ...baseBody, cardUrls: ['https://cards.unstream.stream/curator/abc/def.png'] }));
    expect(data).toMatchObject({ connected: false });
    expect(data.reason).toContain('Reconnect');
  });

  it('refuses a method other than POST', async () => {
    const res = await (handler({ httpMethod: 'GET', headers: {}, rawUrl: 'https://unstream.stream/api/curator/preview' } as never) as Promise<{ statusCode: number }>);
    expect(res.statusCode).toBe(405);
  });

  it('refuses an unknown action', async () => {
    expect((await call('nonsense', baseBody)).statusCode).toBe(404);
  });
});

describe('preview', () => {
  it('renders both networks, with Instagram tagged and Facebook named', async () => {
    const data = json(await call('preview', baseBody));
    expect(data.available).toBe(true);
    expect(data.networks.instagram.caption).toContain('@honeycrush – Luminaires');
    expect(data.networks.facebook.caption).toContain('Honeycrush – Luminaires');
    expect(data.networks.facebook.caption).not.toContain('@honeycrush');
    expect(data.networks.instagram.problem).toBeNull();
  });

  it('places the Instagram tags on the cover and says who could not be tagged', async () => {
    getArtistsBySlugs.mockResolvedValue(new Map([
      ['honeycrush', artistRow('honeycrush', 'Honeycrush')],
      ['axwax', artistRow('axwax', 'AxWax', { platforms: [] })],
    ]));
    const data = json(await call('preview', { ...baseBody, artists: [{ slug: 'honeycrush' }, { slug: 'axwax' }] }));

    expect(data.networks.instagram.tags).toEqual([{ handle: 'honeycrush', x: 0.25, y: 0.3 }]);
    expect(data.networks.instagram.untagged).toEqual(['AxWax']);
    // Facebook tags nobody, so everyone is untagged there — not an error, just the truth.
    expect(data.networks.facebook.tags).toEqual([]);
  });

  it('uses the curator’s chosen release over the artist’s latest', async () => {
    const data = json(await call('preview', { ...baseBody, artists: [{ slug: 'honeycrush', release: 'Vesper' }] }));
    expect(data.networks.instagram.caption).toContain('Vesper');
    expect(data.networks.instagram.caption).not.toContain('Luminaires');
  });

  it('accepts a typed-in handle but refuses one that is not shaped like a handle', async () => {
    getArtistsBySlugs.mockResolvedValue(new Map([['axwax', artistRow('axwax', 'AxWax', { platforms: [] })]]));

    const good = json(await call('preview', { ...baseBody, artists: [{ slug: 'axwax' }], handles: { axwax: { instagram: 'axwax.band' } } }));
    expect(good.artists[0].handles.instagram).toBe('axwax.band');

    const bad = json(await call('preview', { ...baseBody, artists: [{ slug: 'axwax' }], handles: { axwax: { instagram: 'https://instagram.com/axwax' } } }));
    expect(bad.artists[0].handles.instagram).toBeNull();
  });

  it('names artists it does not hold rather than inventing them', async () => {
    getArtistsBySlugs.mockResolvedValue(new Map([['honeycrush', artistRow('honeycrush', 'Honeycrush')]]));
    const data = json(await call('preview', { ...baseBody, artists: [{ slug: 'honeycrush' }, { slug: 'nobody' }] }));
    expect(data.missing).toEqual(['nobody']);
    expect(data.artists).toHaveLength(1);
  });

  it('flags a post too long for one carousel', async () => {
    const many = Array.from({ length: 10 }, (_, i) => [`a${i}`, artistRow(`a${i}`, `Artist ${i}`)] as const);
    getArtistsBySlugs.mockResolvedValue(new Map(many));
    const data = json(await call('preview', { ...baseBody, artists: many.map(([slug]) => ({ slug })) }));
    expect(data.tooManyForOneCarousel).toBe(true);
  });

  it('draws no cards and calls Buffer not at all', async () => {
    await call('preview', baseBody);
    expect(renderCuratorCard).not.toHaveBeenCalled();
    expect(listChannels).not.toHaveBeenCalled();
  });
});

describe('cards', () => {
  it('draws the slide and stores it under the curator’s own prefix', async () => {
    renderCuratorCard.mockResolvedValue(new Uint8Array([1, 2, 3]));
    publishCard.mockResolvedValue('https://cards.unstream.stream/curator/abc/def.png');

    const data = json(await call('cards', { ...baseBody, slide: 'cover' }));
    expect(data.url).toBe('https://cards.unstream.stream/curator/abc/def.png');
    expect(data.altText).toContain('Honeycrush');

    const key = publishCard.mock.calls[0][1] as string;
    expect(key).toMatch(/^curator\/[0-9a-f]{16}\/[0-9a-f]{32}\.png$/);
  });

  it('refuses a slide it does not draw', async () => {
    expect((await call('cards', { ...baseBody, slide: 'photo' })).statusCode).toBe(400);
  });

  it('refuses an artist card for someone not in this post', async () => {
    expect((await call('cards', { ...baseBody, slide: 'curator-artist', artistSlug: 'someone-else' })).statusCode).toBe(400);
  });
});

describe('send', () => {
  const ours = 'https://cards.unstream.stream/curator/abc/def.png';

  beforeEach(() => {
    listChannels.mockResolvedValue([
      { id: 'chan_ig', name: 'nightshift', service: 'instagram', type: 'business', serviceId: '1', isDisconnected: false },
      { id: 'chan_fb', name: 'Night Shift', service: 'facebook', type: 'page', serviceId: '2', isDisconnected: false },
    ]);
    ensureTag.mockResolvedValue('tag_1');
    createPost.mockResolvedValue({ created: [{ id: 'post_ig', status: 'draft', channelId: 'chan_ig' }], errors: [] });
    createContentItem.mockResolvedValue({ created: [{ id: 'post_fb', status: 'draft', channelId: 'chan_fb' }], errors: [], contentItemId: 'item_1' });
    addPostToContentItem.mockResolvedValue(null);
  });

  // The guard that matters: without it the browser could hand Buffer any image on the internet
  // to publish under Unstream's name.
  it('refuses a card URL that is not one of ours', async () => {
    for (const url of ['https://evil.test/card.png', 'https://cards.unstream.stream/weekly/x.png']) {
      const res = await call('send', { ...baseBody, cardUrls: [url] });
      expect(res.statusCode).toBe(400);
    }
    expect(createPost).not.toHaveBeenCalled();
  });

  it('refuses a send with no cards', async () => {
    expect((await call('send', { ...baseBody, cardUrls: [] })).statusCode).toBe(400);
  });

  it('creates both posts as drafts by default and groups them', async () => {
    const data = json(await call('send', { ...baseBody, cardUrls: [ours] }));
    expect(data.draft).toBe(true);
    expect(data.results.instagram.postId).toBe('post_ig');
    expect(data.results.facebook.postId).toBe('post_fb');
    expect(addPostToContentItem).toHaveBeenCalledWith('curator-token', 'item_1', 'post_ig');

    expect(createPost.mock.calls[0][1]).toMatchObject({ channelId: 'chan_ig', saveToDraft: true });
  });

  it('puts the Instagram tags on the first image only', async () => {
    await call('send', { ...baseBody, cardUrls: [ours, ours] });
    const assets = (createPost.mock.calls[0][1] as { assets: { image: { metadata: Record<string, unknown> } }[] }).assets;
    expect(assets[0].image.metadata.userTags).toEqual([{ handle: 'honeycrush', x: 0.25, y: 0.3 }]);
    expect(assets[1].image.metadata.userTags).toBeUndefined();
  });

  it('shares now when asked', async () => {
    await call('send', { ...baseBody, cardUrls: [ours], mode: 'now' });
    expect(createPost.mock.calls[0][1]).toMatchObject({ saveToDraft: false, mode: 'shareNow' });
  });

  // A content item is all-or-nothing, so Instagram goes on its own afterwards. A rejected
  // Instagram post must leave the Facebook one standing.
  it('keeps the Facebook post when Instagram is rejected', async () => {
    createPost.mockResolvedValue({ created: [], errors: [{ channelId: 'chan_ig', message: 'Invalid user tag' }] });

    const res = await call('send', { ...baseBody, cardUrls: [ours] });
    expect(res.statusCode).toBe(200);
    const data = json(res);
    expect(data.results.facebook.postId).toBe('post_fb');
    expect(data.results.instagram.error).toBe('Invalid user tag');
  });

  it('reports a failure when neither network was created', async () => {
    createPost.mockResolvedValue({ created: [], errors: [{ message: 'nope' }] });
    createContentItem.mockResolvedValue({ created: [], errors: [{ message: 'nope' }] });
    expect((await call('send', { ...baseBody, cardUrls: [ours] })).statusCode).toBe(502);
  });

  it('skips a disconnected channel', async () => {
    listChannels.mockResolvedValue([
      { id: 'chan_ig', name: 'x', service: 'instagram', type: 'business', serviceId: '1', isDisconnected: true },
    ]);
    const data = json(await call('send', { ...baseBody, cardUrls: [ours] }));
    expect(createPost).not.toHaveBeenCalled();
    expect(data.results.instagram).toBeUndefined();
  });
});
