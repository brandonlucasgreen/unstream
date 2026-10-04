// /api/me/tips — a fan's record of their tips, and saving a signed-out tip to an account. Locked
// here: only the fan's own tips, in the server's Stripe mode, that actually went through; a claim is
// believed only when Stripe says the session is a paid Unstream tip to that artist, under a day old;
// a tip someone else already saved can't be taken; and the ledger follows the payment.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({
  resolveAccountRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => db.client }));
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '203.0.113.9',
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage } }));

import { handler, CLAIM_WINDOW_SECONDS } from '../me-tips';

const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8';
const fetchMock = vi.fn();

const get = () => handler({ httpMethod: 'GET', headers: { authorization: 'Bearer t' } });
const claim = (body: unknown = { sessionId: SESSION_ID, artistSlug: 'kid-lightbulbs' }) =>
  handler({ httpMethod: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) });

/** Stripe's answer for GET /v1/checkout/sessions/{id}. */
function stripeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    payment_status: 'paid',
    payment_intent: 'pi_1',
    livemode: false,
    created: Math.floor(Date.now() / 1000) - 60,
    metadata: { unstream_kind: 'one_off', unstream_artist_id: 'artist-1', unstream_amount_cents: '500' },
    ...overrides,
  };
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1', artist_id: 'artist-1', stripe_payment_intent_id: 'pi_1', amount_cents: 500, gross_cents: 546,
    currency: 'usd', status: 'succeeded', livemode: false, fan_user_id: null, created_at: '2026-10-03T12:00:00Z',
    artists: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }, support_entries: [{ artist_goals: null }],
    ...overrides,
  };
}

beforeEach(() => {
  db = createFakeDb();
  db.tables.artists = [{ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs' }];
  db.tables.artist_tip_accounts = [{ artist_id: 'artist-1', livemode: false, stripe_account_id: 'acct_artist' }];
  db.tables.tip_payments = [payment()];
  db.tables.support_entries = [{ id: 'entry-1', payment_id: 'pay-1', user_id: null, artist_id: 'artist-1' }];
  db.tables.saved_artists = [{ user_id: 'fan-1', artist_id: 'artist-1', supported: false }];
  vi.resetAllMocks();
  mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:fan-1', user: { userId: 'fan-1' } });
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(stripeSession()))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

describe('auth', () => {
  it('refuses a signed-out request', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:203.0.113.9', user: null });
    expect((await get()).statusCode).toBe(401);
    expect((await claim()).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is behind the account limiter', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: { statusCode: 429, headers: {}, body: '{}' } });
    expect((await get()).statusCode).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('user:fan-1', 'account', expect.any(Object));
  });
});

describe('GET: the fan’s tips', () => {
  it('lists the fan’s own tips that went through, in this Stripe mode', async () => {
    db.tables.tip_payments = [
      payment({ id: 'mine', fan_user_id: 'fan-1', support_entries: [{ artist_goals: { title: 'Vinyl' } }] }),
      payment({ id: 'refunded', fan_user_id: 'fan-1', status: 'refunded' }),
      payment({ id: 'someone-elses', fan_user_id: 'fan-2' }),
      payment({ id: 'anonymous', fan_user_id: null }),
      payment({ id: 'live-while-testing', fan_user_id: 'fan-1', livemode: true }),
      payment({ id: 'failed', fan_user_id: 'fan-1', status: 'failed' }),
    ];
    const res = await get();
    expect(res.statusCode).toBe(200);
    const { tips } = JSON.parse(res.body);
    expect(tips.map((t: { id: string }) => t.id)).toEqual(['mine', 'refunded']);
    expect(tips[0]).toEqual({
      id: 'mine', artistName: 'Kid Lightbulbs', artistSlug: 'kid-lightbulbs', amountCents: 500, paidCents: 546,
      currency: 'usd', status: 'succeeded', goalTitle: 'Vinyl', createdAt: '2026-10-03T12:00:00Z',
    });
  });

  it('returns nothing when tips are switched off (no Stripe key)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    db.tables.tip_payments = [payment({ fan_user_id: 'fan-1' })];
    expect(JSON.parse((await get()).body).tips).toEqual([]);
  });
});

describe('POST: saving a signed-out tip', () => {
  it('attaches the payment and its ledger entry to the fan, and marks the artist supported', async () => {
    const res = await claim();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'saved' });
    expect(db.tables.tip_payments[0].fan_user_id).toBe('fan-1');
    expect(db.tables.support_entries[0].user_id).toBe('fan-1');
    expect(db.tables.saved_artists[0].supported).toBe(true);

    // The session is read from the artist's own connected account.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SESSION_ID}`);
    expect(init.headers['Stripe-Account']).toBe('acct_artist');
  });

  it('is idempotent for the same fan', async () => {
    await claim();
    const again = await claim();
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ status: 'saved' });
  });

  it('finishes the ledger on a retry when that step failed the first time', async () => {
    db.tables.tip_payments[0].fan_user_id = 'fan-1'; // the payment was claimed, the entry wasn't
    await claim();
    expect(db.tables.support_entries[0].user_id).toBe('fan-1');
  });

  it('won’t take a tip already saved to someone else', async () => {
    db.tables.tip_payments[0].fan_user_id = 'fan-2';
    db.tables.support_entries[0].user_id = 'fan-2';
    const res = await claim();
    expect(res.statusCode).toBe(409);
    expect(db.tables.tip_payments[0].fan_user_id).toBe('fan-2');
    expect(db.tables.support_entries[0].user_id).toBe('fan-2');
  });

  it('says pending when Stripe has the payment but the webhook hasn’t recorded it yet', async () => {
    db.tables.tip_payments = [];
    const res = await claim();
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ status: 'pending' });
  });

  it('refuses a session older than the claim window', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(
      stripeSession({ created: Math.floor(Date.now() / 1000) - CLAIM_WINDOW_SECONDS - 60 }),
    ))));
    expect((await claim()).statusCode).toBe(410);
    expect(db.tables.tip_payments[0].fan_user_id).toBeNull();
  });

  it.each([
    ['not an Unstream tip', { metadata: { unstream_kind: 'something_else', unstream_artist_id: 'artist-1' } }],
    ['a tip to a different artist', { metadata: { unstream_kind: 'one_off', unstream_artist_id: 'artist-2' } }],
    ['unpaid', { payment_status: 'unpaid' }],
    ['the other Stripe mode', { livemode: true }],
  ])('refuses a session that is %s', async (_label, overrides) => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(stripeSession(overrides)))));
    expect((await claim()).statusCode).toBe(404);
    expect(db.tables.tip_payments[0].fan_user_id).toBeNull();
  });

  it('answers 404 when Stripe doesn’t know the session', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: { message: 'No such checkout.session', type: 'invalid_request_error' } }), { status: 404 },
    )));
    expect((await claim()).statusCode).toBe(404);
  });

  it('answers 404 for an artist without a tips account, without calling Stripe', async () => {
    db.tables.artist_tip_accounts = [];
    expect((await claim()).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed input before touching Stripe', async () => {
    for (const body of [
      { sessionId: 'pi_123', artistSlug: 'kid-lightbulbs' },
      { sessionId: `${SESSION_ID}/../x`, artistSlug: 'kid-lightbulbs' },
      { sessionId: SESSION_ID, artistSlug: 'Kid Lightbulbs' },
      {},
    ]) {
      expect((await claim(body)).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a Stripe outage to Sentry rather than calling it "not found"', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })));
    expect((await claim()).statusCode).toBe(502);
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
