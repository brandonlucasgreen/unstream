// /api/tips/webhook — the only writer of payments. Locked here: nothing is processed without a
// valid Connect signature (including over a base64 body), a paid session records one payment and
// one ledger entry however often Stripe replays it, a session from the wrong account is refused,
// and refunds, disputes and account changes are mirrored.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../db', () => ({ getClient: () => db.client }));
vi.mock('../../lib/sentry', () => ({ Sentry: mocks }));

import { handler } from '../tips-webhook';

const SECRET = 'whsec_connect_test';

function deliver(evt: Record<string, unknown>, opts: { base64?: boolean; secret?: string } = {}) {
  const raw = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${t}.${raw}`).digest('hex');
  return handler({
    httpMethod: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${sig}` },
    body: opts.base64 ? Buffer.from(raw).toString('base64') : raw,
    isBase64Encoded: opts.base64,
  });
}

const paidSession = (metadata: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  type: 'checkout.session.completed',
  livemode: false,
  account: 'acct_artist',
  data: {
    object: {
      id: 'cs_1',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      amount_total: 546,
      currency: 'usd',
      metadata: {
        unstream_kind: 'one_off', unstream_artist_id: 'artist-1', unstream_amount_cents: '500',
        unstream_application_fee_cents: '0', ...metadata,
      },
      ...extra,
    },
  },
});

beforeEach(() => {
  db = createFakeDb();
  db.unique.tip_payments = [['stripe_payment_intent_id']];
  db.tables.artist_tip_accounts = [{ artist_id: 'artist-1', livemode: false, stripe_account_id: 'acct_artist', fee_basis_points: 0, charges_enabled: false }];
  db.tables.saved_artists = [{ user_id: 'fan-1', artist_id: 'artist-1', supported: false }];
  vi.resetAllMocks();
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET;
});

describe('signature', () => {
  it('rejects a bad signature and writes nothing', async () => {
    const res = await deliver(paidSession(), { secret: 'whsec_wrong' });
    expect(res.statusCode).toBe(400);
    expect(db.tables.tip_payments ?? []).toHaveLength(0);
  });

  it('verifies over the decoded body when Netlify base64-encodes it', async () => {
    const res = await deliver(paidSession(), { base64: true });
    expect(res.statusCode).toBe(200);
    expect(db.tables.tip_payments).toHaveLength(1);
  });

  it('refuses to run without its secret configured', async () => {
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect((await deliver(paidSession())).statusCode).toBe(500);
  });
});

describe('checkout.session.completed', () => {
  it('records the payment and one ledger entry, with the goal and fan', async () => {
    const goal = '11111111-1111-4111-8111-111111111111';
    await deliver(paidSession({ unstream_goal_id: goal, unstream_fan_user_id: 'fan-1' }));

    expect(db.tables.tip_payments).toHaveLength(1);
    expect(db.tables.tip_payments[0]).toMatchObject({
      artist_id: 'artist-1', stripe_account_id: 'acct_artist', stripe_payment_intent_id: 'pi_1',
      amount_cents: 500, gross_cents: 546, application_fee_cents: 0, status: 'succeeded',
      channel: 'checkout', livemode: false, fan_user_id: 'fan-1',
    });
    expect(db.tables.support_entries).toEqual([expect.objectContaining({
      user_id: 'fan-1', artist_id: 'artist-1', amount_cents: 500, source: 'checkout', goal_id: goal,
      payment_id: db.tables.tip_payments[0].id,
    })]);
    // Spec §3.3: the first payment marks a saved artist supported.
    expect(db.tables.saved_artists[0].supported).toBe(true);
  });

  it('is a no-op on replay: still one payment, one entry', async () => {
    await deliver(paidSession());
    const again = await deliver(paidSession());
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).note).toBe('already recorded');
    expect(db.tables.tip_payments).toHaveLength(1);
    expect(db.tables.support_entries).toHaveLength(1);
  });

  it('records a signed-out tip with no user', async () => {
    await deliver(paidSession());
    expect(db.tables.tip_payments[0].fan_user_id).toBeNull();
    expect(db.tables.support_entries[0].user_id).toBeNull();
  });

  it('refuses a session from an account that isn’t this artist’s', async () => {
    const evt = { ...paidSession(), account: 'acct_someone_else' };
    const res = await deliver(evt);
    expect(JSON.parse(res.body).note).toBe('account mismatch');
    expect(db.tables.tip_payments ?? []).toHaveLength(0);
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('refuses a live event against a test-mode account', async () => {
    await deliver({ ...paidSession(), livemode: true });
    expect(db.tables.tip_payments ?? []).toHaveLength(0);
  });

  it('ignores sessions that aren’t Unstream tips or aren’t paid', async () => {
    await deliver(paidSession({ unstream_kind: 'something_else' }));
    await deliver(paidSession({}, { payment_status: 'unpaid' }));
    expect(db.tables.tip_payments ?? []).toHaveLength(0);
  });

  it('records the fee the payment was created with, even if the artist changed it since', async () => {
    // 2026-10-03 in the sandbox: checkout at 5% ($5.76, 29¢ fee), fee switched to 0%, then paid.
    db.tables.artist_tip_accounts[0].fee_basis_points = 0;
    await deliver(paidSession({ unstream_application_fee_cents: '29' }, { amount_total: 576 }));
    expect(db.tables.tip_payments[0].application_fee_cents).toBe(29);
  });

  it('refuses a session whose fee is unusable, so Stripe retries and Sentry hears about it', async () => {
    for (const fee of ['abc', '-1', '9999']) {
      expect((await deliver(paidSession({ unstream_application_fee_cents: fee }, { amount_total: 576 }))).statusCode).toBe(500);
    }
    expect(db.tables.tip_payments ?? []).toHaveLength(0);
  });

  it('asks Stripe for the fee when the session predates storing it (paid across a deploy)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'pi_1', application_fee_amount: 29 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const evt = paidSession({}, { amount_total: 576 });
      delete (evt.data.object.metadata as Record<string, string>).unstream_application_fee_cents;
      expect((await deliver(evt)).statusCode).toBe(200);
      expect(db.tables.tip_payments[0].application_fee_cents).toBe(29);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
      expect(init.headers['Stripe-Account']).toBe('acct_artist');
    } finally {
      vi.unstubAllGlobals();
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});

describe('status changes', () => {
  beforeEach(async () => { await deliver(paidSession()); });
  const evt = (type: string, object: Record<string, unknown>) =>
    ({ id: `evt_${type}`, type, livemode: false, account: 'acct_artist', data: { object } });
  const refunded = (amountRefunded: number) =>
    evt('charge.refunded', { payment_intent: 'pi_1', amount: 546, amount_refunded: amountRefunded, refunded: amountRefunded >= 546 });
  const row = () => db.tables.tip_payments[0];

  it('records a partial refund without changing the status, and a full one as refunded', async () => {
    await deliver(refunded(200));
    expect(row()).toMatchObject({ status: 'succeeded', refunded_cents: 200 });
    await deliver(refunded(546));
    expect(row()).toMatchObject({ status: 'refunded', refunded_cents: 546 });
  });

  it('never lowers refunded_cents when an earlier refund event arrives late', async () => {
    await deliver(refunded(546));
    await deliver(refunded(200));
    expect(row()).toMatchObject({ status: 'refunded', refunded_cents: 546 });
  });

  it('marks a disputed charge disputed', async () => {
    await deliver(evt('charge.dispute.created', { payment_intent: 'pi_1' }));
    expect(row().status).toBe('disputed');
  });

  it('never moves a refunded payment to disputed or back to succeeded', async () => {
    await deliver(refunded(546));
    await deliver(evt('charge.dispute.created', { payment_intent: 'pi_1' }));
    await deliver(evt('charge.dispute.closed', { payment_intent: 'pi_1', status: 'won', charge: 'ch_1' }));
    expect(row().status).toBe('refunded');
  });

  it('ignores payment_intent events: a payment is only created by checkout', async () => {
    const res = await deliver(evt('payment_intent.payment_failed', { id: 'pi_1' }));
    expect(JSON.parse(res.body).note).toBe('ignored');
    expect(row().status).toBe('succeeded');
    await deliver(evt('payment_intent.succeeded', { id: 'pi_unknown' }));
    expect(db.tables.tip_payments).toHaveLength(1);
  });

  it('puts a disputed tip back when the artist wins, or an inquiry closes with a warning', async () => {
    for (const status of ['won', 'warning_closed']) {
      await deliver(evt('charge.dispute.created', { payment_intent: 'pi_1' }));
      await deliver(evt('charge.dispute.closed', { payment_intent: 'pi_1', status, charge: 'ch_1' }));
      expect(row().status).toBe('succeeded');
    }
  });

  it('ignores a won dispute for a payment that was never marked disputed', async () => {
    await deliver(evt('charge.dispute.closed', { payment_intent: 'pi_1', status: 'won', charge: 'ch_1' }));
    expect(row().status).toBe('succeeded');
  });
});

describe('Stripe mode', () => {
  it('ignores events from the other mode, before reading or writing anything', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
    try {
      const res = await deliver(paidSession());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).note).toBe('other mode');
      expect(db.tables.tip_payments ?? []).toHaveLength(0);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});

describe('accounts', () => {
  it('mirrors account.updated', async () => {
    await deliver({ id: 'evt_5', type: 'account.updated', livemode: false, account: 'acct_artist', data: { object: { id: 'acct_artist', charges_enabled: true, details_submitted: true, country: 'GB' } } });
    expect(db.tables.artist_tip_accounts[0]).toMatchObject({ charges_enabled: true, details_submitted: true, country: 'GB' });
  });

  it('switches tips off, clears approval and records the disconnect when the artist deauthorizes Unstream', async () => {
    Object.assign(db.tables.artist_tip_accounts[0], { charges_enabled: true, tips_enabled: true, tips_approved_at: '2026-09-01' });
    await deliver({ id: 'evt_6', type: 'account.application.deauthorized', livemode: false, account: 'acct_artist', data: { object: {} } });
    expect(db.tables.artist_tip_accounts[0]).toMatchObject({
      charges_enabled: false, tips_enabled: false, tips_approved_at: null, deauthorized_at: expect.any(String),
    });
  });
});

describe('a refund hands back Unstream’s fee', () => {
  const fetchMock = vi.fn();
  // Stripe's application fee object, as GET /v1/application_fees/{id} returns it.
  let fee = { amount: 29, amount_refunded: 0 };
  const refundEvent = (charge: Record<string, unknown>) => ({
    id: 'evt_r', type: 'charge.refunded', livemode: false, account: 'acct_artist',
    data: { object: { payment_intent: 'pi_1', application_fee: 'fee_1', amount: 576, ...charge } },
  });
  const feeRefunds = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/v1/application_fees/fee_1/refunds') && init.method === 'POST');

  beforeEach(async () => {
    await deliver(paidSession({ unstream_application_fee_cents: '29' }, { amount_total: 576 }));
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    fee = { amount: 29, amount_refunded: 0 };
    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init: { method: string; body?: string }) => {
      if (init.method === 'POST') {
        fee.amount_refunded += Number(new URLSearchParams(init.body).get('amount'));
        return Promise.resolve(new Response(JSON.stringify({ id: 'fr_1' })));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 'fee_1', ...fee })));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

  it('returns the whole fee on a full refund, on Unstream’s own account, idempotently', async () => {
    const res = await deliver(refundEvent({ refunded: true, amount_refunded: 576 }));
    expect(res.statusCode).toBe(200);
    expect(db.tables.tip_payments[0].status).toBe('refunded');
    const [[, init]] = feeRefunds();
    expect(new URLSearchParams(init.body).get('amount')).toBe('29');
    expect(init.headers['Stripe-Account']).toBeUndefined();
    expect(init.headers['Idempotency-Key']).toBe('fee-refund:fee_1:29');
  });

  it('returns a share of the fee on a partial refund, and the rest when it becomes full', async () => {
    await deliver(refundEvent({ refunded: false, amount_refunded: 288 }));
    expect(db.tables.tip_payments[0].status).toBe('succeeded');
    expect(fee.amount_refunded).toBe(15); // round(29 × 288 / 576)
    await deliver(refundEvent({ refunded: true, amount_refunded: 576 }));
    expect(fee.amount_refunded).toBe(29);
  });

  it('never returns the fee twice when Stripe replays the event', async () => {
    await deliver(refundEvent({ refunded: true, amount_refunded: 576 }));
    await deliver(refundEvent({ refunded: true, amount_refunded: 576 }));
    expect(feeRefunds()).toHaveLength(1);
    expect(fee.amount_refunded).toBe(29);
  });

  it('leaves the artist’s own sales alone: no application fee, no Stripe call', async () => {
    await deliver(refundEvent({ payment_intent: 'pi_artists_own_sale', application_fee: null, refunded: true, amount_refunded: 576 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables.tip_payments[0].status).toBe('succeeded');
  });

  it('records the partial refund amount on the payment', async () => {
    await deliver(refundEvent({ refunded: false, amount_refunded: 288 }));
    expect(db.tables.tip_payments[0]).toMatchObject({ status: 'succeeded', refunded_cents: 288 });
  });

  it('fails the event so Stripe retries when the fee refund itself fails', async () => {
    fetchMock.mockImplementation((_url: string, init: { method: string }) => Promise.resolve(
      init.method === 'POST'
        ? new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
        : new Response(JSON.stringify({ id: 'fee_1', ...fee })),
    ));
    expect((await deliver(refundEvent({ refunded: true, amount_refunded: 576 }))).statusCode).toBe(500);
  });
});

describe('the fan’s receipt', () => {
  const fetchMock = vi.fn();
  let charge: Record<string, unknown>;
  const withEmail = () => paidSession({}, { customer_details: { email: 'fan@example.com' } });
  const receiptUpdates = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/v1/charges/ch_1') && init.method === 'POST');

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    charge = { id: 'ch_1', receipt_email: null, receipt_number: null };
    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init: { method: string }) => Promise.resolve(new Response(JSON.stringify(
      init.method === 'GET' ? { id: 'pi_1', latest_charge: charge } : { id: 'ch_1' },
    ))));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

  it('has Stripe send the artist’s receipt to the address the fan gave Checkout', async () => {
    await deliver(withEmail());
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect(getUrl).toBe('https://api.stripe.com/v1/payment_intents/pi_1?expand%5B0%5D=latest_charge');
    expect(getInit.headers['Stripe-Account']).toBe('acct_artist');
    const [[, init]] = receiptUpdates();
    expect(new URLSearchParams(init.body).get('receipt_email')).toBe('fan@example.com');
    expect(init.headers['Stripe-Account']).toBe('acct_artist');
  });

  it('never stores the address', async () => {
    await deliver(withEmail());
    expect(JSON.stringify(db.tables)).not.toContain('fan@example.com');
  });

  it('leaves it alone when Stripe already sent one', async () => {
    charge.receipt_number = '1234-5678';
    await deliver(withEmail());
    expect(receiptUpdates()).toHaveLength(0);
  });

  it('sends it once, not again on a replayed event', async () => {
    await deliver(withEmail());
    await deliver(withEmail());
    expect(receiptUpdates()).toHaveLength(1);
  });

  it('does nothing without an address', async () => {
    await deliver(paidSession());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still records the tip when the receipt fails, and doesn’t make Stripe retry', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })));
    const res = await deliver(withEmail());
    expect(res.statusCode).toBe(200);
    expect(db.tables.tip_payments).toHaveLength(1);
    expect(mocks.captureException).toHaveBeenCalled();
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('fan@example.com');
  });
});

describe('a refund that fails or is canceled', () => {
  const fetchMock = vi.fn();
  let charge = { id: 'ch_1', amount: 576, amount_refunded: 0 };
  const refundUpdated = (status: string, extra: Record<string, unknown> = {}) => ({
    id: 'evt_ru', type: 'charge.refund.updated', livemode: false, account: 'acct_artist',
    data: { object: { id: 're_1', status, charge: 'ch_1', payment_intent: 'pi_1', ...extra } },
  });

  beforeEach(async () => {
    await deliver(paidSession({}, { amount_total: 576 }));
    Object.assign(db.tables.tip_payments[0], { status: 'refunded', refunded_cents: 576 });
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    charge = { id: 'ch_1', amount: 576, amount_refunded: 0 };
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(charge))));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

  it('recounts from the charge on the artist’s account, and the tip counts again', async () => {
    expect((await deliver(refundUpdated('failed'))).statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/charges/ch_1');
    expect(init.headers['Stripe-Account']).toBe('acct_artist');
    expect(db.tables.tip_payments[0]).toMatchObject({ status: 'succeeded', refunded_cents: 0 });
  });

  it('keeps a payment refunded when another refund still covers all of it', async () => {
    charge.amount_refunded = 576;
    await deliver(refundUpdated('canceled'));
    expect(db.tables.tip_payments[0]).toMatchObject({ status: 'refunded', refunded_cents: 576 });
  });

  it('ignores refund updates that aren’t failures, and refunds on the artist’s own sales', async () => {
    await deliver(refundUpdated('succeeded'));
    await deliver(refundUpdated('failed', { payment_intent: 'pi_artists_own_sale' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables.tip_payments[0].status).toBe('refunded');
  });
});

describe('a lost dispute hands back Unstream’s fee', () => {
  const fetchMock = vi.fn();
  let fee = { amount: 29, amount_refunded: 0 };
  const lost = () => ({
    id: 'evt_dc', type: 'charge.dispute.closed', livemode: false, account: 'acct_artist',
    data: { object: { id: 'dp_1', status: 'lost', charge: 'ch_1', payment_intent: 'pi_1' } },
  });
  const feeRefunds = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/v1/application_fees/fee_1/refunds') && init.method === 'POST');

  beforeEach(async () => {
    await deliver(paidSession({ unstream_application_fee_cents: '29' }, { amount_total: 576 }));
    db.tables.tip_payments[0].status = 'disputed';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    fee = { amount: 29, amount_refunded: 0 };
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init: { method: string; body?: string }) => {
      if (String(url).includes('/v1/charges/')) {
        return Promise.resolve(new Response(JSON.stringify({ id: 'ch_1', amount: 576, amount_refunded: 0, application_fee: 'fee_1' })));
      }
      if (init.method === 'POST') {
        fee.amount_refunded += Number(new URLSearchParams(init.body).get('amount'));
        return Promise.resolve(new Response(JSON.stringify({ id: 'fr_1' })));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 'fee_1', ...fee })));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

  it('returns what’s left of the fee, keyed on the fee and amount, and leaves the payment disputed', async () => {
    fee.amount_refunded = 10;
    expect((await deliver(lost())).statusCode).toBe(200);
    const [[, init]] = feeRefunds();
    expect(new URLSearchParams(init.body).get('amount')).toBe('19');
    expect(init.headers['Idempotency-Key']).toBe('fee-dispute:fee_1:29');
    expect(init.headers['Stripe-Account']).toBeUndefined();
    expect(db.tables.tip_payments[0].status).toBe('disputed');
  });

  it('never returns it twice on a replay', async () => {
    await deliver(lost());
    await deliver(lost());
    expect(feeRefunds()).toHaveLength(1);
    expect(fee.amount_refunded).toBe(29);
  });
});
