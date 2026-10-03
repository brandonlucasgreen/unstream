// The artist side: /api/tips/connect and /api/tips/settings. Locked here: only the owner of a
// verified claim gets anywhere; the account is created as Standard with Stripe as controller,
// only once, and only after the addendum is accepted in a supported country; the fee stays in
// 0–5%; tips can't be switched on before Stripe enables charges; three open goals at most.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({
  resolveOwnedArtist: vi.fn(),
  authenticateBearer: vi.fn(),
  checkRateLimit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('../db', () => ({ getClient: () => db.client, resolveOwnedArtist: mocks.resolveOwnedArtist }));
vi.mock('../ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit, getClientIp: () => '203.0.113.9' }));
vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateBearer: mocks.authenticateBearer,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage } }));

import { handler as rawConnect } from '../tips-connect';
import { handler as rawSettings } from '../tips-settings';
const connect = async (body: unknown) => (await rawConnect({ httpMethod: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) }))!;
const put = async (body: unknown) => (await rawSettings({ httpMethod: 'PUT', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) }))!;
const get = async () => (await rawSettings({ httpMethod: 'GET', headers: { authorization: 'Bearer t' }, body: null, queryStringParameters: { slug: 'kid-lightbulbs' } }))!;

const fetchMock = vi.fn();
const OWNER = { userId: 'owner-1', email: 'o@example.com' };

beforeEach(() => {
  db = createFakeDb();
  db.defaults.artist_goals = { status: 'open' };
  db.defaults.artist_tip_accounts = { tips_approved_at: null, tips_enabled: false, fee_basis_points: 0 };
  db.rpc.get_goal_progress = () => [];
  db.rpc.get_artist_tip_totals = () => [{ payment_count: 2, gross_cents: 1092, amount_cents: 1000, application_fee_cents: 0 }];
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.authenticateBearer.mockResolvedValue(OWNER);
  mocks.resolveOwnedArtist.mockResolvedValue({ ok: true, status: 200, artistId: 'artist-1', artistName: 'Kid Lightbulbs' });
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/v1/accounts') ? { id: 'acct_new', country: 'US', charges_enabled: false }
      : url.endsWith('/v1/account_links') ? { url: 'https://connect.stripe.com/setup/s/abc' }
        : { id: 'acct_new', charges_enabled: true, details_submitted: true, country: 'US' },
  ))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

const account = (overrides: Record<string, unknown> = {}) => ({
  artist_id: 'artist-1', livemode: false, stripe_account_id: 'acct_new', user_id: 'owner-1',
  charges_enabled: true, details_submitted: true, country: 'US', tips_approved_at: null,
  tips_enabled: false, fee_basis_points: 0, ...overrides,
});

describe('tips-connect', () => {
  it('creates a Standard account controlled by Stripe, then returns an onboarding link', async () => {
    const res = await connect({ slug: 'kid-lightbulbs', country: 'us', acceptAddendum: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://connect.stripe.com/setup/s/abc');

    const [, init] = fetchMock.mock.calls[0];
    const form = new URLSearchParams(init.body);
    expect(form.get('country')).toBe('US');
    expect(form.get('controller[stripe_dashboard][type]')).toBe('full');
    expect(form.get('controller[fees][payer]')).toBe('account');
    expect(form.get('controller[losses][payments]')).toBe('stripe');
    expect(form.get('controller[requirement_collection]')).toBe('stripe');
    expect(init.headers['Idempotency-Key']).toBe('connect:artist-1:test');
    expect(init.headers['Stripe-Account']).toBeUndefined();

    expect(db.tables.artist_tip_accounts).toEqual([expect.objectContaining({
      artist_id: 'artist-1', livemode: false, stripe_account_id: 'acct_new', user_id: 'owner-1',
      tips_approved_at: null, addendum_version: expect.any(String),
    })]);
  });

  it('requires the artist addendum and a supported country for a new account', async () => {
    expect((await connect({ slug: 'kid-lightbulbs', country: 'US' })).statusCode).toBe(400);
    const res = await connect({ slug: 'kid-lightbulbs', country: 'NG', acceptAddendum: true });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('unsupported_country');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the artist back to the Manage Tips tab, not the dashboard', async () => {
    db.tables.artist_tip_accounts = [account({ charges_enabled: false })];
    process.env.URL = 'http://localhost:8888';
    try {
      await connect({ slug: 'kid-lightbulbs' });
    } finally {
      delete process.env.URL;
    }
    const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(form.get('return_url')).toBe('http://localhost:8888/artist-edit/kid-lightbulbs/tips?stripe=return');
    expect(form.get('refresh_url')).toBe('http://localhost:8888/artist-edit/kid-lightbulbs/tips?stripe=refresh');
  });

  it('reuses an existing account: a fresh link, no second account', async () => {
    db.tables.artist_tip_accounts = [account({ charges_enabled: false })];
    await connect({ slug: 'kid-lightbulbs' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.stripe.com/v1/account_links');
  });

  it('never hands a new owner a link into a previous owner’s account', async () => {
    db.tables.artist_tip_accounts = [account({ user_id: 'previous-owner' })];
    expect((await connect({ slug: 'kid-lightbulbs' })).statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-owner and a signed-out caller', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: false, status: 403, error: 'You do not own this profile' });
    expect((await connect({ slug: 'kid-lightbulbs', country: 'US', acceptAddendum: true })).statusCode).toBe(403);
    mocks.authenticateBearer.mockResolvedValue(null);
    expect((await connect({ slug: 'kid-lightbulbs' })).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tips-settings', () => {
  it('reports each state an artist can be in', async () => {
    expect(JSON.parse((await get()).body).state).toBe('not_connected');
    db.tables.artist_tip_accounts = [account({ charges_enabled: false })];
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'acct_new', charges_enabled: false })));
    expect(JSON.parse((await get()).body).state).toBe('onboarding');
    db.tables.artist_tip_accounts = [account()];
    expect(JSON.parse((await get()).body).state).toBe('awaiting_approval');
    db.tables.artist_tip_accounts = [account({ tips_approved_at: '2026-09-01' })];
    const body = JSON.parse((await get()).body);
    expect(body.state).toBe('connected');
    expect(body.totals.allTime).toEqual({ count: 2, grossCents: 1092, netCents: 1092 - 32 - 60, applicationFeeCents: 0 });
  });

  it('picks up onboarding finished on Stripe without waiting for the webhook', async () => {
    db.tables.artist_tip_accounts = [account({ charges_enabled: false, details_submitted: false })];
    const body = JSON.parse((await get()).body);
    expect(body.state).toBe('awaiting_approval');
    expect(db.tables.artist_tip_accounts[0].charges_enabled).toBe(true);
  });

  it('tells "Stripe needs more from you" apart from "Stripe is reviewing" and "Stripe declined"', async () => {
    const stripeSays = (requirements: Record<string, unknown>) => {
      db.tables.artist_tip_accounts = [account({ charges_enabled: false, details_submitted: true })];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'acct_new', charges_enabled: false, details_submitted: true, country: 'US', requirements,
      })));
    };
    // The real sandbox account on 2026-10-02: onboarding done, but the full SSN still owed.
    stripeSays({ currently_due: ['individual.id_number'], past_due: ['individual.id_number'], disabled_reason: 'requirements.past_due' });
    expect(JSON.parse((await get()).body).state).toBe('onboarding');

    stripeSays({ currently_due: [], past_due: [], disabled_reason: 'requirements.pending_verification' });
    expect(JSON.parse((await get()).body).state).toBe('stripe_review');

    stripeSays({ currently_due: [], past_due: [], disabled_reason: 'rejected.other' });
    expect(JSON.parse((await get()).body).state).toBe('stripe_declined');
  });

  it('falls back to "needs details" when Stripe can’t be read, and reports it', async () => {
    db.tables.artist_tip_accounts = [account({ charges_enabled: false, details_submitted: true })];
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
    expect(JSON.parse((await get()).body).state).toBe('onboarding');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('hides a previous owner’s account and its totals', async () => {
    db.tables.artist_tip_accounts = [account({ user_id: 'previous-owner', tips_approved_at: '2026-09-01' })];
    const body = JSON.parse((await get()).body);
    expect(body.state).toBe('not_connected');
    expect(body.foreignAccount).toBe(true);
    expect(body.totals).toBeNull();
  });

  it('keeps the Unstream fee within 0–5%', async () => {
    db.tables.artist_tip_accounts = [account()];
    expect((await put({ slug: 'kid-lightbulbs', action: 'update', feeBasisPoints: 501 })).statusCode).toBe(400);
    expect((await put({ slug: 'kid-lightbulbs', action: 'update', feeBasisPoints: 300 })).statusCode).toBe(200);
    expect(db.tables.artist_tip_accounts[0].fee_basis_points).toBe(300);
  });

  it('won’t switch tips on before Stripe enables charges', async () => {
    db.tables.artist_tip_accounts = [account({ charges_enabled: false })];
    expect((await put({ slug: 'kid-lightbulbs', action: 'update', tipsEnabled: true })).statusCode).toBe(409);
    expect(db.tables.artist_tip_accounts[0].tips_enabled).toBe(false);
  });

  it('allows three open goals, and closes only this artist’s', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: `Goal ${i}`, targetCents: 240000 })).statusCode).toBe(200);
    }
    expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: 'One more', targetCents: 1000 })).statusCode).toBe(409);

    db.tables.artist_goals.push({ id: '22222222-2222-4222-8222-222222222222', artist_id: 'other-artist', status: 'open' });
    await put({ slug: 'kid-lightbulbs', action: 'closeGoal', goalId: '22222222-2222-4222-8222-222222222222' });
    expect(db.tables.artist_goals.find(g => g.artist_id === 'other-artist')?.status).toBe('open');
  });

  it('validates goal titles and targets', async () => {
    expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: '', targetCents: 1000 })).statusCode).toBe(400);
    expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: 'x'.repeat(81), targetCents: 1000 })).statusCode).toBe(400);
    expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: 'Vinyl', targetCents: 50 })).statusCode).toBe(400);
    expect((await put({ slug: 'kid-lightbulbs', action: 'createGoal', title: '<b>Vinyl</b>', targetCents: 1000 })).statusCode).toBe(400);
  });

  it('returns the artist name for the settings header', async () => {
    expect(JSON.parse((await get()).body).artistName).toBe('Kid Lightbulbs');
  });

  it('answers the tab check without reading the profile, database or Stripe', async () => {
    const summary = async () => (await rawSettings({
      httpMethod: 'GET', headers: { authorization: 'Bearer t' }, body: null, queryStringParameters: { summary: '1' },
    }))!;
    expect(JSON.parse((await summary()).body)).toEqual({ available: true });
    delete process.env.STRIPE_SECRET_KEY;
    expect(JSON.parse((await summary()).body)).toEqual({ available: false });
    expect(mocks.resolveOwnedArtist).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Still signed-in only.
    mocks.authenticateBearer.mockResolvedValue(null);
    expect((await summary()).statusCode).toBe(401);
  });

  it('checks ownership on every call', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: false, status: 403, error: 'You do not own this profile' });
    expect((await get()).statusCode).toBe(403);
    expect((await put({ slug: 'kid-lightbulbs', action: 'update', feeBasisPoints: 0 })).statusCode).toBe(403);
  });
});
