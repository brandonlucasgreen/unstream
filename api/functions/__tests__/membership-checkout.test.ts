import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMembership: vi.fn(),
  checkRateLimit: vi.fn(),
  createSession: vi.fn(),
  getStripe: vi.fn(),
  priceIdForPlan: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader
      ? { key: 'user:user-1', user: { userId: 'user-1', email: 'fan@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../membership')>()),
  getMembership: mocks.getMembership,
}));
vi.mock('../stripe-client', () => ({
  getStripe: mocks.getStripe,
  priceIdForPlan: mocks.priceIdForPlan,
  siteUrl: () => 'https://unstream.stream',
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage },
}));

import { handler } from '../membership-checkout';

type Res = { statusCode: number; headers: Record<string, string>; body: string };

/** The handler's response, narrowed: a rate-limit branch widens its declared type. */
async function call(...args: Parameters<typeof handler>): Promise<Res> {
  const res = await handler(...args);
  if (!res) throw new Error('handler returned no response');
  return res as Res;
}

function post(body: unknown, authorization: string | null = 'Bearer good') {
  return call({
    httpMethod: 'POST',
    headers: authorization ? { authorization } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const activeMonthly = {
  user_id: 'user-1',
  plan: 'monthly',
  status: 'active',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  amount_cents: 300,
  currency: 'usd',
  current_period_end: new Date(Date.now() + 86400000).toISOString(),
  canceled_at: null,
};

describe('membership-checkout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getStripe.mockReturnValue({ checkout: { sessions: { create: mocks.createSession } } });
    mocks.priceIdForPlan.mockImplementation((plan: string) => `price_${plan}`);
    mocks.createSession.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test' });
    mocks.getMembership.mockResolvedValue(null);
  });

  it('requires sign-in', async () => {
    expect((await post({ plan: 'monthly' }, null)).statusCode).toBe(401);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects bad JSON and unknown plans, including grandfathered', async () => {
    expect((await post('{nope')).statusCode).toBe(400);
    expect((await post({ plan: 'platinum' })).statusCode).toBe(400);
    expect((await post({ plan: 'grandfathered' })).statusCode).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('creates a Managed Payments subscription checkout tied to the user', async () => {
    const res = await post({ plan: 'annual' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test' });

    const params = mocks.createSession.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_annual', quantity: 1 }],
      managed_payments: { enabled: true },
      client_reference_id: 'user-1',
      customer_email: 'fan@example.com',
      metadata: { user_id: 'user-1', plan: 'annual' },
      subscription_data: { metadata: { user_id: 'user-1', plan: 'annual' } },
      success_url: 'https://unstream.stream/open-studio?membership=thanks',
      cancel_url: 'https://unstream.stream/open-studio',
    });
  });

  it('uses payment mode and always creates a customer for lifetime', async () => {
    await post({ plan: 'lifetime' });
    const params = mocks.createSession.mock.calls[0][0];
    expect(params.mode).toBe('payment');
    expect(params.customer_creation).toBe('always');
    expect(params.subscription_data).toBeUndefined();
  });

  it('refuses a second membership', async () => {
    mocks.getMembership.mockResolvedValue(activeMonthly);
    expect((await post({ plan: 'lifetime' })).statusCode).toBe(409);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('lets a grandfathered member choose to pay', async () => {
    mocks.getMembership.mockResolvedValue({
      ...activeMonthly,
      plan: 'grandfathered',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
    });
    expect((await post({ plan: 'monthly' })).statusCode).toBe(200);
  });

  it('reuses the Stripe customer of someone returning after cancelling', async () => {
    mocks.getMembership.mockResolvedValue({ ...activeMonthly, status: 'canceled' });
    await post({ plan: 'monthly' });
    const params = mocks.createSession.mock.calls[0][0];
    expect(params.customer).toBe('cus_1');
    expect(params.customer_email).toBeUndefined();
  });

  it('returns 503 when Stripe is not configured, and reports it', async () => {
    mocks.getStripe.mockReturnValue(null);
    expect((await post({ plan: 'monthly' })).statusCode).toBe(503);
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('does not start checkout when the membership read fails', async () => {
    mocks.getMembership.mockRejectedValue(new Error('db down'));
    expect((await post({ plan: 'monthly' })).statusCode).toBe(502);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
