// /api/admin/flags. Locked here: it is admin-only; GET reports every known flag as off rather
// than failing when Redis is unreachable (the store fails closed); a name outside the registry
// is a 400 rather than a new flag; and a write that did not land is a 503, never a 200.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: new Map<string, string>(),
  client: null as Record<string, unknown> | null,
  hgetall: vi.fn(),
  hset: vi.fn(),
  getRedis: vi.fn(),
  reportRedisFailure: vi.fn(),
  authenticateAdmin: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../redis', () => ({
  getRedis: mocks.getRedis,
  reportRedisFailure: mocks.reportRedisFailure,
}));
vi.mock('../middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: mocks.authenticateAdmin,
}));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: mocks.captureMessage, captureException: vi.fn() },
}));

const { handler } = await import('../admin-flags');

const get = (headers: Record<string, string> = { authorization: 'Bearer admin' }) =>
  handler({ httpMethod: 'GET', headers });
const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer admin' }) =>
  handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });

const flagsOf = (response: { body?: string | null }) => JSON.parse(response.body || '{}').flags;
const errorOf = (response: { body?: string | null }) => JSON.parse(response.body || '{}').error;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hash.clear();
  mocks.client = {
    hgetall: (key: string) => mocks.hgetall(key),
    hset: (key: string, value: Record<string, string>) => mocks.hset(key, value),
  };
  mocks.getRedis.mockImplementation(() => mocks.client);
  mocks.hgetall.mockImplementation(async () => Object.fromEntries(mocks.hash));
  mocks.hset.mockImplementation(async (_key: string, value: Record<string, string>) => {
    for (const [field, stored] of Object.entries(value)) mocks.hash.set(field, stored);
    return 1;
  });
  mocks.authenticateAdmin.mockResolvedValue({ userId: 'admin-1', email: 'admin@example.com' });
});

describe('admin-flags', () => {
  it('is admin-only', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(401);
    expect((await post({ flag: 'tips', enabled: true })).statusCode).toBe(401);
    // An unauthenticated caller never reaches the store.
    expect(mocks.hgetall).not.toHaveBeenCalled();
    expect(mocks.hset).not.toHaveBeenCalled();
  });

  it('answers CORS preflight before auth', async () => {
    const response = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://unstream.stream' } });
    expect(response.statusCode).toBe(204);
    expect((response.headers as Record<string, string>)['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });

  it('GET on an empty hash reports both flags off', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(flagsOf(response)).toEqual({ tips: false, emailChange: false });
  });

  it('GET reports only the flag whose field is "on"', async () => {
    mocks.hash.set('tips', 'on');
    expect(flagsOf(await get())).toEqual({ tips: true, emailChange: false });
  });

  it('GET ignores a hash field that is not a known flag', async () => {
    mocks.hash.set('tips', 'on');
    mocks.hash.set('tipsV2', 'on');
    expect(flagsOf(await get())).toEqual({ tips: true, emailChange: false });
  });

  it('GET still succeeds, all off, when Redis throws', async () => {
    mocks.hgetall.mockRejectedValue(new Error('WRONGTYPE, command was: ["HGETALL","feature-flags"]'));
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(flagsOf(response)).toEqual({ tips: false, emailChange: false });
    expect(mocks.reportRedisFailure).toHaveBeenCalled();
  });

  it('POST rejects a flag that is not in the registry', async () => {
    const response = await post({ flag: 'tipsV2', enabled: true });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toContain('tips');
    expect(mocks.hset).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ flag: 'tips' }], [{ flag: 'tips', enabled: 'true' }], [{ flag: 7, enabled: true }]])(
    'POST rejects %j',
    async (body) => {
      expect((await post(body)).statusCode).toBe(400);
      expect(mocks.hset).not.toHaveBeenCalled();
    },
  );

  it('POST writes exactly one field and value, and returns the updated map', async () => {
    const response = await post({ flag: 'tips', enabled: true });
    expect(response.statusCode).toBe(200);
    expect(mocks.hset).toHaveBeenCalledWith('feature-flags', { tips: 'on' });
    expect([...mocks.hash.entries()]).toEqual([['tips', 'on']]);
    expect(flagsOf(response)).toEqual({ tips: true, emailChange: false });
  });

  it('POST switching a flag off writes "off" and returns it off', async () => {
    mocks.hash.set('emailChange', 'on');
    const response = await post({ flag: 'emailChange', enabled: false });
    expect(mocks.hset).toHaveBeenCalledWith('feature-flags', { emailChange: 'off' });
    expect(flagsOf(response)).toEqual({ tips: false, emailChange: false });
  });

  it('POST returns 503, changing nothing, when Redis is unavailable', async () => {
    mocks.getRedis.mockReturnValue(null);
    const response = await post({ flag: 'tips', enabled: true });
    expect(response.statusCode).toBe(503);
    expect(errorOf(response)).toEqual(expect.any(String));
    expect(mocks.hset).not.toHaveBeenCalled();
  });

  it('POST returns 503 when the write itself fails', async () => {
    mocks.hset.mockRejectedValue(new Error('ECONNRESET'));
    const response = await post({ flag: 'tips', enabled: true });
    expect(response.statusCode).toBe(503);
    expect(mocks.hash.size).toBe(0);
    expect(mocks.reportRedisFailure).toHaveBeenCalled();
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('rejects a method it does not serve', async () => {
    expect((await handler({ httpMethod: 'DELETE', headers: { authorization: 'Bearer admin' } })).statusCode).toBe(405);
  });
});
