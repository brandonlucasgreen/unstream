import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMembership: vi.fn(),
  checkRateLimit: vi.fn(),
  createPortal: vi.fn(),
  getStripe: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader
      ? { key: 'user:user-1', user: { userId: 'user-1', email: 'fan@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../membership', () => ({ getMembership: mocks.getMembership }));
vi.mock('../stripe-client', () => ({ getStripe: mocks.getStripe, siteUrl: () => 'https://unstream.stream' }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));

import { handler } from '../membership-portal';

type Res = { statusCode: number; headers: Record<string, string>; body: string };

/** The handler's response, narrowed: a rate-limit branch widens its declared type. */
async function call(...args: Parameters<typeof handler>): Promise<Res> {
  const res = await handler(...args);
  if (!res) throw new Error('handler returned no response');
  return res as Res;
}

const POST = { httpMethod: 'POST', headers: { authorization: 'Bearer good' } };

describe('membership-portal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getStripe.mockReturnValue({ billingPortal: { sessions: { create: mocks.createPortal } } });
    mocks.createPortal.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test' });
  });

  it('requires sign-in', async () => {
    expect((await call({ ...POST, headers: {} })).statusCode).toBe(401);
  });

  it('opens the portal for the member’s own Stripe customer', async () => {
    mocks.getMembership.mockResolvedValue({ user_id: 'user-1', stripe_customer_id: 'cus_1' });
    const res = await call(POST);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://billing.stripe.com/p/session/test');
    expect(mocks.createPortal).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://unstream.stream/open-books',
    });
  });

  it('has nothing to manage for a grandfathered or non-member', async () => {
    mocks.getMembership.mockResolvedValue({ user_id: 'user-1', stripe_customer_id: null });
    expect((await call(POST)).statusCode).toBe(404);
    mocks.getMembership.mockResolvedValue(null);
    expect((await call(POST)).statusCode).toBe(404);
    expect(mocks.createPortal).not.toHaveBeenCalled();
  });
});
