// The hand-rolled Stripe client: form encoding, webhook signatures, key-mode detection, headers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { encodeForm, stripeMode, stripeRequest, verifyStripeSignature, StripeError } from '../stripe';

const SECRET = 'whsec_test_secret';
const sign = (body: string, t: number, secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('encodeForm', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    const form = encodeForm({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { unit_amount: 546 } }],
      skipped: null,
      also: undefined,
      success_url: 'https://x/thanks?session_id={CHECKOUT_SESSION_ID}',
    });
    expect(decodeURIComponent(form)).toBe(
      'mode=payment&line_items[0][quantity]=1&line_items[0][price_data][unit_amount]=546' +
      '&success_url=https://x/thanks?session_id={CHECKOUT_SESSION_ID}',
    );
  });
});

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;

  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(body, sign(body, now), SECRET, now)).toBe(true);
  });

  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${now},v1=${'0'.repeat(64)},${sign(body, now).split(',')[1]}`;
    expect(verifyStripeSignature(body, header, SECRET, now)).toBe(true);
  });

  it('rejects the wrong secret, a tampered body, and a missing header', () => {
    expect(verifyStripeSignature(body, sign(body, now, 'whsec_other'), SECRET, now)).toBe(false);
    expect(verifyStripeSignature('{"id":"evt_2"}', sign(body, now), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', SECRET, now)).toBe(false);
  });

  it('rejects an old timestamp (replay)', () => {
    expect(verifyStripeSignature(body, sign(body, now - 301), SECRET, now)).toBe(false);
  });
});

describe('stripeMode', () => {
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  it('reads the mode from the key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    expect(stripeMode()).toBe('test');
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
    expect(stripeMode()).toBe('live');
    process.env.STRIPE_SECRET_KEY = 'pk_test_publishable';
    expect(stripeMode()).toBeNull();
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeMode()).toBeNull();
  });
});

describe('stripeRequest', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

  it('acts on the connected account when asked (direct charges)', async () => {
    fetchMock.mockResolvedValue(new Response('{"id":"cs_1"}', { status: 200 }));
    await stripeRequest('POST', '/v1/checkout/sessions', { mode: 'payment' }, { stripeAccount: 'acct_artist' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers['Stripe-Account']).toBe('acct_artist');
    expect(init.headers.Authorization).toBe('Bearer sk_test_abc');
    expect(init.body).toBe('mode=payment');
  });

  it('throws a StripeError carrying Stripe’s message', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"No such account","code":"account_invalid"}}', { status: 400 }));
    await expect(stripeRequest('GET', '/v1/accounts/acct_x')).rejects.toMatchObject({
      name: 'StripeError', status: 400, code: 'account_invalid', message: 'No such account',
    });
  });

  it('refuses to call Stripe with no key configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(stripeRequest('GET', '/v1/accounts/acct_x')).rejects.toBeInstanceOf(StripeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
