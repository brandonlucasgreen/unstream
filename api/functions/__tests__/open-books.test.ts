import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ listLiveMemberships: vi.fn(), captureException: vi.fn() }));

vi.mock('../membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../membership')>()),
  listLiveMemberships: mocks.listLiveMemberships,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

import { handler } from '../open-books';

type Res = { statusCode: number; headers: Record<string, string>; body: string };

/** The handler's response, narrowed: a rate-limit branch widens its declared type. */
async function call(...args: Parameters<typeof handler>): Promise<Res> {
  const res = await handler(...args);
  if (!res) throw new Error('handler returned no response');
  return res as Res;
}

function member(i: number) {
  return {
    user_id: `user-${i}`,
    plan: 'monthly',
    status: 'active',
    stripe_customer_id: `cus_${i}`,
    stripe_subscription_id: `sub_${i}`,
    amount_cents: 300,
    currency: 'usd',
    current_period_end: new Date(Date.now() + 86400000).toISOString(),
    canceled_at: null,
  };
}

describe('open-books', () => {
  beforeEach(() => vi.resetAllMocks());

  it('publishes aggregates only, CDN-cached', async () => {
    mocks.listLiveMemberships.mockResolvedValue([1, 2, 3, 4, 5, 6].map(member));
    const res = await call({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toContain('s-maxage=3600');

    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ activeMembers: 6, monthlyRecurringCents: 1800, belowThreshold: false });
    // Nothing per-member ever leaves the function.
    expect(res.body).not.toContain('user-1');
    expect(res.body).not.toContain('cus_');
  });

  it('withholds counts below the public threshold', async () => {
    mocks.listLiveMemberships.mockResolvedValue([member(1), member(2)]);
    const body = JSON.parse((await call({ httpMethod: 'GET' })).body);
    expect(body).toMatchObject({ activeMembers: null, monthlyRecurringCents: null, belowThreshold: true });
  });

  it('does not cache a failed read', async () => {
    mocks.listLiveMemberships.mockRejectedValue(new Error('db down'));
    const res = await call({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
