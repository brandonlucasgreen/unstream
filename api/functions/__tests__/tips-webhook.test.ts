// /api/tips/webhook — the only writer of payments. Locked here: nothing is processed without a
// valid Connect signature (including over a base64 body), a paid session records one payment and
// one ledger entry however often Stripe replays it, a session from the wrong account is refused,
// and refunds, disputes and account changes are mirrored.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      metadata: { unstream_kind: 'one_off', unstream_artist_id: 'artist-1', unstream_amount_cents: '500', ...metadata },
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

  it('records the fee from the artist’s setting', async () => {
    db.tables.artist_tip_accounts[0].fee_basis_points = 500;
    await deliver(paidSession({}, { amount_total: 1000 }));
    expect(db.tables.tip_payments[0].application_fee_cents).toBe(50);
  });
});

describe('status changes', () => {
  beforeEach(async () => { await deliver(paidSession()); });

  it('marks a fully refunded charge refunded, and leaves a partial refund alone', async () => {
    await deliver({ id: 'evt_2', type: 'charge.refunded', livemode: false, account: 'acct_artist', data: { object: { payment_intent: 'pi_1', refunded: false } } });
    expect(db.tables.tip_payments[0].status).toBe('succeeded');
    await deliver({ id: 'evt_3', type: 'charge.refunded', livemode: false, account: 'acct_artist', data: { object: { payment_intent: 'pi_1', refunded: true } } });
    expect(db.tables.tip_payments[0].status).toBe('refunded');
  });

  it('marks a disputed charge disputed', async () => {
    await deliver({ id: 'evt_4', type: 'charge.dispute.created', livemode: false, account: 'acct_artist', data: { object: { payment_intent: 'pi_1' } } });
    expect(db.tables.tip_payments[0].status).toBe('disputed');
  });
});

describe('accounts', () => {
  it('mirrors account.updated', async () => {
    await deliver({ id: 'evt_5', type: 'account.updated', livemode: false, account: 'acct_artist', data: { object: { id: 'acct_artist', charges_enabled: true, details_submitted: true, country: 'GB' } } });
    expect(db.tables.artist_tip_accounts[0]).toMatchObject({ charges_enabled: true, details_submitted: true, country: 'GB' });
  });

  it('switches tips off and clears approval when the artist disconnects Unstream', async () => {
    Object.assign(db.tables.artist_tip_accounts[0], { charges_enabled: true, tips_enabled: true, tips_approved_at: '2026-09-01' });
    await deliver({ id: 'evt_6', type: 'account.application.deauthorized', livemode: false, account: 'acct_artist', data: { object: {} } });
    expect(db.tables.artist_tip_accounts[0]).toMatchObject({ charges_enabled: false, tips_enabled: false, tips_approved_at: null });
  });
});
