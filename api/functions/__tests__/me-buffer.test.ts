// The curator's Buffer connection endpoint: its gate, and the organization and channels it keeps.
//
// The `curatorPosts` flag fails closed for everyone but the admin account, which is let through
// so the feature can be tested before it is switched on. The OAuth callback carries no user to
// check, and relies on only ever redeeming a state that the gated /start minted.
//
// The organization is chosen, never guessed: taking the account's first one posted from the
// wrong workspace for anyone who belongs to more than one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getFeatureFlag = vi.fn();
const resolveAccountRequest = vi.fn();
const getBufferConnection = vi.fn();
const saveBufferConnection = vi.fn();
const setOrganization = vi.fn();
const setSelectedChannels = vi.fn();
const exchangeCode = vi.fn();
const listOrganizations = vi.fn();
const listChannels = vi.fn();
const resumeAfterReconnect = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock('../feature-flags', () => ({ getFeatureFlag: (...a: unknown[]) => getFeatureFlag(...a) }));

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: (...a: unknown[]) => resolveAccountRequest(...a),
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));

vi.mock('../redis', () => ({
  getRedis: () => ({
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
  }),
}));

vi.mock('../buffer-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-db')>()),
  getBufferConnection: (...a: unknown[]) => getBufferConnection(...a),
  saveBufferConnection: (...a: unknown[]) => saveBufferConnection(...a),
  setOrganization: (...a: unknown[]) => setOrganization(...a),
  setSelectedChannels: (...a: unknown[]) => setSelectedChannels(...a),
  usableAccessToken: async () => 'token',
}));

vi.mock('../release-autopost-db', () => ({ resumeAfterReconnect: (...a: unknown[]) => resumeAfterReconnect(...a) }));

vi.mock('../buffer-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-oauth')>()),
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
}));

vi.mock('../buffer-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-client')>()),
  listOrganizations: (...a: unknown[]) => listOrganizations(...a),
  listChannels: (...a: unknown[]) => listChannels(...a),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  withSentry: (h: unknown) => h,
}));

const { handler } = await import('../me-buffer');
const { Sentry } = await import('../../lib/sentry');

type Res = { statusCode: number; headers: Record<string, string>; body: string };

const call = (method: string, path: string, query = '', body?: unknown) =>
  handler({
    httpMethod: method,
    headers: { authorization: 'Bearer t' },
    rawUrl: `https://unstream.stream/api/me/buffer${path}${query}`,
    body: body === undefined ? null : JSON.stringify(body),
  } as never) as Promise<Res>;

const asUser = (email: string) =>
  resolveAccountRequest.mockResolvedValue({ key: 'user:u1', user: { userId: 'u1', email } });

beforeEach(() => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
  vi.stubEnv('BUFFER_CLIENT_ID', 'client');
  vi.stubEnv('BUFFER_CLIENT_SECRET', 'secret');
  getFeatureFlag.mockResolvedValue(false);
  getBufferConnection.mockResolvedValue(null);
  listOrganizations.mockResolvedValue([{ id: 'org_mine', name: 'Cult of Lightbulbs' }, { id: 'org_work', name: 'Buffer' }]);
  listChannels.mockResolvedValue([
    { id: 'ig_1', name: 'kidlightbulbs', service: 'instagram', type: 'business', serviceId: '1', isDisconnected: false },
    { id: 'ig_2', name: 'unstream.stream', service: 'instagram', type: 'business', serviceId: '2', isDisconnected: false },
    { id: 'th_1', name: 'kidlightbulbs', service: 'threads', type: 'profile', serviceId: '3', isDisconnected: false },
    { id: 'fb_old', name: 'Old page', service: 'facebook', type: 'page', serviceId: '4', isDisconnected: true },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('the gate', () => {
  it('reports itself unavailable to a curator while the flag is off', async () => {
    asUser('curator@example.com');
    expect(JSON.parse((await call('GET', '')).body)).toEqual({ available: false });
    expect(getBufferConnection).not.toHaveBeenCalled();
  });

  it('opens to every signed-in curator once the flag is on', async () => {
    getFeatureFlag.mockResolvedValue(true);
    asUser('curator@example.com');
    expect(JSON.parse((await call('GET', '')).body)).toEqual({ available: true, connected: false });
  });

  it('lets the admin account connect while the flag is off', async () => {
    asUser('Admin@Example.com');
    expect(JSON.parse((await call('GET', '')).body)).toEqual({ available: true, connected: false });

    const start = JSON.parse((await call('POST', '/start')).body);
    expect(start.authorizeUrl).toMatch(/^https:\/\/auth\.buffer\.com\//);
    expect(redisSet).toHaveBeenCalledOnce();
  });

  it('refuses /start to a curator while the flag is off, so no state is minted', async () => {
    asUser('curator@example.com');
    expect(JSON.parse((await call('POST', '/start')).body)).toEqual({ available: false });
    expect(redisSet).not.toHaveBeenCalled();
  });

  // The admin's round trip through Buffer has to land, or connecting could never be tested.
  it('redeems a state /start minted, whatever the flag says', async () => {
    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v' });
    exchangeCode.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date() });
    listOrganizations.mockResolvedValue([{ id: 'org_1', name: 'Mine' }]);

    const res = await call('GET', '/callback', '?state=s&code=c');
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toMatch(/\/curator\/new\?buffer=connected$/);
    expect(saveBufferConnection).toHaveBeenCalledWith('u1', expect.anything(), 'org_1');
  });

  // A connection without a refresh token ends when its first access token does, an hour later.
  it('connects, but reports at once when Buffer granted no refresh token, with the scopes it did grant', async () => {
    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v' });
    exchangeCode.mockResolvedValue({ accessToken: 'a', refreshToken: null, expiresAt: new Date(), scope: 'posts:write account:read' });
    listOrganizations.mockResolvedValue([{ id: 'org_1', name: 'Mine' }]);

    const res = await call('GET', '/callback', '?state=s&code=c');
    expect(res.headers.Location).toMatch(/buffer=connected$/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('without a refresh token'),
      expect.objectContaining({ extra: { userId: 'u1', scope: 'posts:write account:read' } }),
    );
  });

  // Release autopost pauses when the connection is lost; reconnecting is all it should take.
  it('starts paused release autopost again on reconnect, and still connects if that fails', async () => {
    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v' });
    exchangeCode.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date() });
    listOrganizations.mockResolvedValue([{ id: 'org_1', name: 'Mine' }]);

    await call('GET', '/callback', '?state=s&code=c');
    expect(resumeAfterReconnect).toHaveBeenCalledWith('u1', ['org_1']);

    resumeAfterReconnect.mockRejectedValueOnce(new Error('database down'));
    const res = await call('GET', '/callback', '?state=s&code=c');
    expect(res.headers.Location).toMatch(/buffer=connected$/);
  });

  it('returns to the Promote page that started the flow', async () => {
    asUser('admin@example.com');
    await call('POST', '/start', '', { returnTo: '/promote/kid-lightbulbs' });
    expect(redisSet.mock.calls[0][1]).toMatchObject({ returnTo: '/promote/kid-lightbulbs' });

    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v', returnTo: '/promote/kid-lightbulbs' });
    exchangeCode.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date() });
    const res = await call('GET', '/callback', '?state=s&code=c');
    expect(res.headers.Location).toBe('https://unstream.stream/promote/kid-lightbulbs?buffer=connected');
  });

  it('sends a declined connection back to the page that started it too', async () => {
    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v', returnTo: '/promote/kid-lightbulbs' });
    const res = await call('GET', '/callback', '?state=s&error=access_denied');
    expect(res.headers.Location).toBe('https://unstream.stream/promote/kid-lightbulbs?buffer=cancelled');
  });

  it('refuses to return anywhere but the pages that connect Buffer', async () => {
    asUser('admin@example.com');
    for (const returnTo of ['https://evil.example', '//evil.example', '/settings', '/promote/x/../../admin', '/artist-edit/x/promote']) {
      expect((await call('POST', '/start', '', { returnTo })).statusCode).toBe(400);
    }
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('lets in an account that release autopost allows, even with curator posts off', async () => {
    getFeatureFlag.mockImplementation(async (flag: string) => flag === 'releaseAutopost');
    asUser('artist@example.com');
    expect(JSON.parse((await call('GET', '')).body)).toEqual({ available: true, connected: false });
  });

  it('turns away a callback whose state nobody minted', async () => {
    redisGet.mockResolvedValue(null);
    const res = await call('GET', '/callback', '?state=forged&code=c');
    expect(res.headers.Location).toMatch(/buffer=expired$/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});

describe('the organization', () => {
  const connected = (organizationId: string | null, selectedChannelIds: string[] = []) =>
    getBufferConnection.mockResolvedValue({ organizationId, selectedChannelIds, refreshCounter: 0 });

  beforeEach(() => {
    getFeatureFlag.mockResolvedValue(true);
    asUser('curator@example.com');
  });

  it('leaves it unchosen at connect when the account has several', async () => {
    redisGet.mockResolvedValue({ userId: 'u1', verifier: 'v' });
    exchangeCode.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date() });

    await call('GET', '/callback', '?state=s&code=c');
    expect(saveBufferConnection).toHaveBeenCalledWith('u1', expect.anything(), null);
  });

  it('offers the organizations, and no channels, until one is chosen', async () => {
    connected(null);
    const data = JSON.parse((await call('GET', '')).body);
    expect(data).toMatchObject({ connected: true, organizationId: null, channels: [] });
    expect(data.organizations.map((o: { name: string }) => o.name)).toEqual(['Cult of Lightbulbs', 'Buffer']);
    expect(listChannels).not.toHaveBeenCalled();
  });

  it('treats an organization they have since left as unchosen', async () => {
    connected('org_gone');
    const data = JSON.parse((await call('GET', '')).body);
    expect(data.organizationId).toBeNull();
    expect(listChannels).not.toHaveBeenCalled();
  });

  it('switches to one of their own organizations', async () => {
    connected('org_work');
    const res = await call('POST', '/organization', '', { organizationId: 'org_mine' });
    expect(res.statusCode).toBe(200);
    expect(setOrganization).toHaveBeenCalledWith('u1', 'org_mine');
  });

  it('refuses an organization the account does not belong to', async () => {
    connected('org_work');
    const res = await call('POST', '/organization', '', { organizationId: 'org_someone_else' });
    expect(res.statusCode).toBe(400);
    expect(setOrganization).not.toHaveBeenCalled();
  });
});

describe('the channels', () => {
  beforeEach(() => {
    getFeatureFlag.mockResolvedValue(true);
    asUser('curator@example.com');
    getBufferConnection.mockResolvedValue({ organizationId: 'org_mine', selectedChannelIds: ['ig_2', 'fb_old'], refreshCounter: 0 });
  });

  it('lists the live channels, marks which can be posted to, and drops stale ticks', async () => {
    const data = JSON.parse((await call('GET', '')).body);
    expect(data.organizationId).toBe('org_mine');
    expect(data.channels).toEqual([
      { id: 'ig_1', name: 'kidlightbulbs', service: 'instagram', supported: true },
      { id: 'ig_2', name: 'unstream.stream', service: 'instagram', supported: true },
      { id: 'th_1', name: 'kidlightbulbs', service: 'threads', supported: false },
    ]);
    expect(data.selectedChannelIds).toEqual(['ig_2']);
  });

  it('stores only channels this organization has and curator posts can use', async () => {
    const res = await call('POST', '/channels', '', { channelIds: ['ig_1', 'th_1', 'fb_old', 'nope', 'ig_1'] });
    expect(JSON.parse(res.body).selectedChannelIds).toEqual(['ig_1']);
    expect(setSelectedChannels).toHaveBeenCalledWith('u1', ['ig_1']);
  });

  it('refuses to store channels before an organization is chosen', async () => {
    getBufferConnection.mockResolvedValue({ organizationId: null, selectedChannelIds: [], refreshCounter: 0 });
    const res = await call('POST', '/channels', '', { channelIds: ['ig_1'] });
    expect(res.statusCode).toBe(409);
    expect(setSelectedChannels).not.toHaveBeenCalled();
  });
});
