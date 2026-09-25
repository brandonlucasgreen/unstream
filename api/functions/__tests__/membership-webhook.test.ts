import { describe, it, expect, vi, beforeEach } from 'vitest';
import Stripe from 'stripe';

const SECRET = 'whsec_test_secret';
// A real SDK instance, never used for network calls: only its webhook signing and verifying,
// so these tests exercise the actual signature check rather than a mock of it.
const realStripe = new Stripe('sk_test_not_a_real_key');

const mocks = vi.hoisted(() => ({
  getMembership: vi.fn(),
  getUserIdForCustomer: vi.fn(),
  upsertMembership: vi.fn(),
  retrieveSubscription: vi.fn(),
  getStripe: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../membership')>()),
  getMembership: mocks.getMembership,
  getUserIdForCustomer: mocks.getUserIdForCustomer,
  upsertMembership: mocks.upsertMembership,
}));
vi.mock('../stripe-client', () => ({ getStripe: mocks.getStripe }));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
}));

import { handler } from '../membership-webhook';

const PERIOD_END = 1793000000;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    canceled_at: null,
    metadata: { user_id: 'user-1', plan: 'monthly' },
    items: {
      data: [
        {
          current_period_end: PERIOD_END,
          price: { unit_amount: 300, currency: 'usd', recurring: { interval: 'month' } },
        },
      ],
    },
    ...overrides,
  };
}

function signedEvent(type: string, object: Record<string, unknown>, options: { base64?: boolean } = {}) {
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object } });
  const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': signature },
    body: options.base64 ? Buffer.from(payload, 'utf8').toString('base64') : payload,
    isBase64Encoded: options.base64 ?? false,
  };
}

describe('membership-webhook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STRIPE_MEMBERSHIP_WEBHOOK_SECRET = SECRET;
    mocks.getStripe.mockReturnValue({
      webhooks: realStripe.webhooks,
      subscriptions: { retrieve: mocks.retrieveSubscription },
    });
    mocks.retrieveSubscription.mockResolvedValue(subscription());
    mocks.getMembership.mockResolvedValue(null);
    mocks.upsertMembership.mockResolvedValue(undefined);
  });

  it('rejects a bad signature without touching the database', async () => {
    const event = signedEvent('customer.subscription.updated', { id: 'sub_1' });
    const res = await handler({ ...event, headers: { 'stripe-signature': 't=1,v1=forged' } });
    expect(res.statusCode).toBe(400);
    expect(mocks.upsertMembership).not.toHaveBeenCalled();
  });

  it('rejects a body altered after signing', async () => {
    const event = signedEvent('customer.subscription.updated', { id: 'sub_1' });
    const res = await handler({ ...event, body: event.body.replace('sub_1', 'sub_2') });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing signature header', async () => {
    const event = signedEvent('customer.subscription.updated', { id: 'sub_1' });
    expect((await handler({ ...event, headers: {} })).statusCode).toBe(400);
  });

  it('verifies a base64-encoded body, as Netlify may deliver it', async () => {
    const res = await handler(signedEvent('customer.subscription.updated', { id: 'sub_1' }, { base64: true }));
    expect(res.statusCode).toBe(200);
    expect(mocks.upsertMembership).toHaveBeenCalled();
  });

  it('re-reads the subscription from Stripe rather than trusting the event body', async () => {
    // The event says canceled; Stripe's current truth says active. Current truth wins.
    await handler(signedEvent('customer.subscription.updated', { id: 'sub_1', status: 'canceled' }));
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(mocks.upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        plan: 'monthly',
        status: 'active',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        amount_cents: 300,
        current_period_end: new Date(PERIOD_END * 1000).toISOString(),
      })
    );
  });

  it('writes the same row when an event is replayed', async () => {
    const event = signedEvent('customer.subscription.updated', { id: 'sub_1' });
    await handler(event);
    await handler(event);
    expect(mocks.upsertMembership).toHaveBeenCalledTimes(2);
    expect(mocks.upsertMembership.mock.calls[0][0]).toEqual(mocks.upsertMembership.mock.calls[1][0]);
  });

  it('links a subscription checkout to the user in client_reference_id', async () => {
    mocks.retrieveSubscription.mockResolvedValue(subscription({ metadata: {} }));
    await handler(
      signedEvent('checkout.session.completed', {
        id: 'cs_1',
        mode: 'subscription',
        client_reference_id: 'user-9',
        subscription: 'sub_1',
      })
    );
    expect(mocks.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-9' }));
  });

  it('records a paid lifetime purchase', async () => {
    await handler(
      signedEvent('checkout.session.completed', {
        id: 'cs_2',
        mode: 'payment',
        payment_status: 'paid',
        client_reference_id: 'user-1',
        customer: 'cus_1',
        amount_subtotal: 10000,
        currency: 'usd',
        metadata: { user_id: 'user-1', plan: 'lifetime' },
      })
    );
    expect(mocks.upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'lifetime', status: 'active', current_period_end: null })
    );
  });

  it('does not grant lifetime before the money arrives', async () => {
    await handler(
      signedEvent('checkout.session.completed', {
        id: 'cs_3',
        mode: 'payment',
        payment_status: 'unpaid',
        client_reference_id: 'user-1',
        metadata: { plan: 'lifetime' },
      })
    );
    expect(mocks.upsertMembership).not.toHaveBeenCalled();
  });

  it('falls back to the customer id when a subscription has no user metadata', async () => {
    mocks.retrieveSubscription.mockResolvedValue(subscription({ metadata: {} }));
    mocks.getUserIdForCustomer.mockResolvedValue('user-7');
    await handler(signedEvent('customer.subscription.deleted', { id: 'sub_1' }));
    expect(mocks.getUserIdForCustomer).toHaveBeenCalledWith('cus_1');
    expect(mocks.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-7' }));
  });

  it('acknowledges, and reports, a subscription it cannot attach to anyone', async () => {
    mocks.retrieveSubscription.mockResolvedValue(subscription({ metadata: {} }));
    mocks.getUserIdForCustomer.mockResolvedValue(null);
    const res = await handler(signedEvent('customer.subscription.updated', { id: 'sub_1' }));
    expect(res.statusCode).toBe(200);
    expect(mocks.upsertMembership).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('returns 500 on a database failure so Stripe retries', async () => {
    mocks.upsertMembership.mockRejectedValue(new Error('db down'));
    const res = await handler(signedEvent('customer.subscription.updated', { id: 'sub_1' }));
    expect(res.statusCode).toBe(500);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('acknowledges event types it does not handle', async () => {
    const res = await handler(signedEvent('invoice.paid', { id: 'in_1' }));
    expect(res.statusCode).toBe(200);
    expect(mocks.upsertMembership).not.toHaveBeenCalled();
  });

  it('refuses to process anything when the webhook secret is missing', async () => {
    delete process.env.STRIPE_MEMBERSHIP_WEBHOOK_SECRET;
    const res = await handler(signedEvent('customer.subscription.updated', { id: 'sub_1' }));
    expect(res.statusCode).toBe(500);
    expect(mocks.upsertMembership).not.toHaveBeenCalled();
  });
});
