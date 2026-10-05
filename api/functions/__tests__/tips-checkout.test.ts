// /api/tips/checkout — the one place a fan's payment form is created. Locked here: the server
// decides every figure; the charge is a direct charge on the artist's own account; an artist who
// isn't claimed, connected, approved, switched on *and* connected by the current owner can't be
// paid; and the strict limiter fronts it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  authenticateBearerFast: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => db.client }));
vi.mock('../ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit, getClientIp: () => '203.0.113.9' }));
vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateBearerFast: mocks.authenticateBearerFast,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage } }));

import { handler as rawHandler } from '../tips-checkout';
const handler = async (e: Parameters<typeof rawHandler>[0]) => (await rawHandler(e))!;

const fetchMock = vi.fn();
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });

function seedTippableArtist(overrides: Record<string, unknown> = {}) {
  db.tables.artists = [{ id: 'artist-1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', image_url: null, match_confidence: 'claimed' }];
  db.tables.artist_profiles = [{ artist_id: 'artist-1', user_id: 'owner-1', verified_at: '2026-01-01', custom_image_url: null }];
  db.tables.artist_tip_accounts = [{
    artist_id: 'artist-1', livemode: false, stripe_account_id: 'acct_artist', user_id: 'owner-1',
    charges_enabled: true, tips_approved_at: '2026-09-01', tips_enabled: true, fee_basis_points: 0,
    ...overrides,
  }];
  db.tables.artist_goals = [{ id: '11111111-1111-4111-8111-111111111111', artist_id: 'artist-1', title: 'Vinyl', target_cents: 240000, status: 'open', livemode: false, created_at: '2026-09-01' }];
}

beforeEach(() => {
  db = createFakeDb();
  db.rpc.get_goal_progress = () => [];
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.authenticateBearerFast.mockResolvedValue(null);
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  process.env.URL = 'https://unstream.stream';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

function sentForm(): URLSearchParams {
  return new URLSearchParams(fetchMock.mock.calls[0][1].body);
}

describe('POST — creating the payment', () => {
  it('creates a direct charge on the artist’s account for the grossed-up amount', async () => {
    seedTippableArtist();
    const res = await post({ artistSlug: 'kid-lightbulbs', amountCents: 500, coverFees: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://checkout.stripe.com/c/pay/cs_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers['Stripe-Account']).toBe('acct_artist');
    const form = sentForm();
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('546');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    // A 0% fee sends no application fee at all.
    expect(form.get('payment_intent_data[application_fee_amount]')).toBeNull();
    expect(form.get('payment_intent_data[metadata][unstream_artist_id]')).toBe('artist-1');
    expect(form.get('line_items[0][price_data][product_data][name]')).toBe("Support for Kid Lightbulbs's music");
  });

  it('takes the artist’s chosen fee as the application fee, from the database not the request', async () => {
    seedTippableArtist({ fee_basis_points: 500 });
    await post({ artistSlug: 'kid-lightbulbs', amountCents: 1000, coverFees: false, feeBasisPoints: 0, grossCents: 1 });
    const form = sentForm();
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('1000');
    expect(form.get('payment_intent_data[application_fee_amount]')).toBe('50');
    // …and carries that fee in the metadata the webhook records it from.
    expect(form.get('metadata[unstream_application_fee_cents]')).toBe('50');
    expect(form.get('payment_intent_data[metadata][unstream_application_fee_cents]')).toBe('50');
  });

  it('refuses amounts outside $3–$500 before touching Stripe', async () => {
    seedTippableArtist();
    for (const amountCents of [100, 299, 50001, 5.5, '500']) {
      expect((await post({ artistSlug: 'kid-lightbulbs', amountCents })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not approved by an admin', { tips_approved_at: null }],
    ['switched off by the artist', { tips_enabled: false }],
    ['not enabled for charges by Stripe', { charges_enabled: false }],
    ['connected by a previous owner of the profile', { user_id: 'someone-else' }],
    ['connected in the other Stripe mode', { livemode: true }],
    ['disconnected by the artist in Stripe', { deauthorized_at: '2026-10-01' }],
  ])('refuses an artist whose account is %s', async (_label, overrides) => {
    seedTippableArtist(overrides);
    const res = await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 });
    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an artist who is no longer claimed', async () => {
    seedTippableArtist();
    db.tables.artists[0].match_confidence = 'verified';
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 })).statusCode).toBe(409);
  });

  it('refuses when Stripe is not configured', async () => {
    seedTippableArtist();
    delete process.env.STRIPE_SECRET_KEY;
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 })).statusCode).toBe(503);
  });

  it('tags an open goal, and refuses a closed or foreign one', async () => {
    seedTippableArtist();
    const goalId = '11111111-1111-4111-8111-111111111111';
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500, goalId })).statusCode).toBe(200);
    expect(sentForm().get('metadata[unstream_goal_id]')).toBe(goalId);

    db.tables.artist_goals[0].status = 'closed';
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500, goalId })).statusCode).toBe(400);
    // A goal made in the other Stripe mode (testing locally against production data) isn't open here.
    Object.assign(db.tables.artist_goals[0], { status: 'open', livemode: true });
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500, goalId })).statusCode).toBe(400);
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500, goalId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('attributes the tip to a signed-in fan', async () => {
    seedTippableArtist();
    mocks.authenticateBearerFast.mockResolvedValue({ userId: 'fan-9', email: 'f@example.com' });
    await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 }, { authorization: 'Bearer t' });
    expect(sentForm().get('metadata[unstream_fan_user_id]')).toBe('fan-9');
  });

  it('is fronted by the strict limiter', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: { statusCode: 429, headers: {}, body: '' } });
    const res = await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 });
    expect(res.statusCode).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('ip:203.0.113.9', 'strict', expect.anything());
  });

  it('says so, without leaking Stripe’s error, when Stripe fails', async () => {
    seedTippableArtist();
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"secret internal detail"}}', { status: 500 }));
    const res = await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret internal detail');
    expect(mocks.captureException).toHaveBeenCalled();
  });
});

describe('Stripe refusals, CORS and fee-less countries', () => {
  it('tells the fan the artist can’t take tips when Stripe refuses the session, without Stripe’s words', async () => {
    seedTippableArtist();
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"account cannot create charges"}}', { status: 400 }));
    const res = await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("This artist can't take tips right now.");
    expect(res.body).not.toContain('cannot create charges');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('keeps "try again" for Stripe rate limits', async () => {
    seedTippableArtist();
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"slow down"}}', { status: 429 }));
    expect((await post({ artistSlug: 'kid-lightbulbs', amountCents: 500 })).statusCode).toBe(502);
  });

  it('is restricted to unstream.stream, not open to every origin', async () => {
    seedTippableArtist();
    const res = await handler({ httpMethod: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ artistSlug: 'kid-lightbulbs', amountCents: 500 }) });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
    const preflight = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://unstream.stream' }, body: null });
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
  });

  it('sends no Unstream fee for an account in a country where Stripe doesn’t allow one', async () => {
    seedTippableArtist({ fee_basis_points: 500, country: 'BR' });
    await post({ artistSlug: 'kid-lightbulbs', amountCents: 1000, coverFees: false });
    expect(sentForm().get('payment_intent_data[application_fee_amount]')).toBeNull();
    expect(sentForm().get('metadata[unstream_application_fee_cents]')).toBe('0');
    const page = await handler({ httpMethod: 'GET', headers: {}, body: null, queryStringParameters: { slug: 'kid-lightbulbs' } });
    expect(JSON.parse(page.body).feeBasisPoints).toBe(0);
  });
});

describe('GET — the tip page', () => {
  it('returns the artist, fee and open goals for an artist taking tips', async () => {
    seedTippableArtist({ fee_basis_points: 250 });
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null, queryStringParameters: { slug: 'kid-lightbulbs' } });
    const body = JSON.parse(res.body);
    expect(body.takingTips).toBe(true);
    expect(body.feeBasisPoints).toBe(250);
    expect(body.goals).toHaveLength(1);
    expect(body.minCents).toBe(300);
  });

  it('says an artist isn’t taking tips, without their settings', async () => {
    seedTippableArtist({ tips_enabled: false });
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null, queryStringParameters: { slug: 'kid-lightbulbs' } });
    const body = JSON.parse(res.body);
    expect(body.takingTips).toBe(false);
    expect(body.feeBasisPoints).toBeUndefined();
    expect(body.artist.name).toBe('Kid Lightbulbs');
  });
});
