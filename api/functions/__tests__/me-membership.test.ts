import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMembership: vi.fn(),
  checkRateLimit: vi.fn(),
  captureException: vi.fn(),
}));

/** An Authorization header whose token does not verify — see the ratelimit mock below. */
const REJECTED_TOKEN = 'Bearer rejected-token';

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader && authHeader !== REJECTED_TOKEN
      ? { key: 'user:user-1', user: { userId: 'user-1', email: 'fan@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../membership')>()),
  getMembership: mocks.getMembership,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

import { handler } from '../me-membership';

type Res = { statusCode: number; headers: Record<string, string>; body: string };

/** The handler's response, narrowed: a rate-limit branch widens its declared type. */
async function call(...args: Parameters<typeof handler>): Promise<Res> {
  const res = await handler(...args);
  if (!res) throw new Error('handler returned no response');
  return res as Res;
}

const GET = { httpMethod: 'GET', headers: { authorization: 'Bearer good' } };

describe('me-membership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
  });

  it('rejects a token that was checked and failed, not just an absent one', async () => {
    expect((await call({ ...GET, headers: { authorization: REJECTED_TOKEN } })).statusCode).toBe(401);
    expect((await call({ ...GET, headers: {} })).statusCode).toBe(401);
  });

  it('reports a non-member', async () => {
    mocks.getMembership.mockResolvedValue(null);
    const res = await call(GET);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      active: false,
      plan: null,
      status: null,
      currentPeriodEnd: null,
      canManage: false,
    });
  });

  it('reports an active member who can manage their plan', async () => {
    mocks.getMembership.mockResolvedValue({
      user_id: 'user-1',
      plan: 'annual',
      status: 'active',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      amount_cents: 2500,
      currency: 'usd',
      current_period_end: new Date(Date.now() + 86400000).toISOString(),
      canceled_at: null,
    });
    const body = JSON.parse((await call(GET)).body);
    expect(body).toMatchObject({ active: true, plan: 'annual', canManage: true });
    expect(mocks.getMembership).toHaveBeenCalledWith('user-1');
  });

  it('returns 503 on a failed read rather than "not a member"', async () => {
    mocks.getMembership.mockRejectedValue(new Error('db down'));
    const res = await call(GET);
    expect(res.statusCode).toBe(503);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('is never cached in a shared cache', async () => {
    mocks.getMembership.mockResolvedValue(null);
    expect((await call(GET)).headers['Cache-Control']).toBe('private, no-store');
  });
});
