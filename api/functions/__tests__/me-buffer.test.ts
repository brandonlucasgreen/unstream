// The curator's Buffer connection endpoint: its gate.
//
// The `curatorPosts` flag fails closed for everyone but the admin account, which is let through
// so the feature can be tested before it is switched on. The OAuth callback carries no user to
// check, and relies on only ever redeeming a state that the gated /start minted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getFeatureFlag = vi.fn();
const resolveAccountRequest = vi.fn();
const getBufferConnection = vi.fn();
const saveBufferConnection = vi.fn();
const exchangeCode = vi.fn();
const bufferGraphQL = vi.fn();
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
}));

vi.mock('../buffer-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-oauth')>()),
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
}));

vi.mock('../buffer-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-client')>()),
  bufferGraphQL: (...a: unknown[]) => bufferGraphQL(...a),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  withSentry: (h: unknown) => h,
}));

const { handler } = await import('../me-buffer');

type Res = { statusCode: number; headers: Record<string, string>; body: string };

const call = (method: string, path: string, query = '') =>
  handler({
    httpMethod: method,
    headers: { authorization: 'Bearer t' },
    rawUrl: `https://unstream.stream/api/me/buffer${path}${query}`,
  } as never) as Promise<Res>;

const asUser = (email: string) =>
  resolveAccountRequest.mockResolvedValue({ key: 'user:u1', user: { userId: 'u1', email } });

beforeEach(() => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
  vi.stubEnv('BUFFER_CLIENT_ID', 'client');
  vi.stubEnv('BUFFER_CLIENT_SECRET', 'secret');
  getFeatureFlag.mockResolvedValue(false);
  getBufferConnection.mockResolvedValue(null);
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
    bufferGraphQL.mockResolvedValue({ account: { organizations: [{ id: 'org_1' }] } });

    const res = await call('GET', '/callback', '?state=s&code=c');
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toMatch(/\/curator\/new\?buffer=connected$/);
    expect(saveBufferConnection).toHaveBeenCalledWith('u1', expect.anything(), 'org_1');
  });

  it('turns away a callback whose state nobody minted', async () => {
    redisGet.mockResolvedValue(null);
    const res = await call('GET', '/callback', '?state=forged&code=c');
    expect(res.headers.Location).toMatch(/buffer=expired$/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});
