// /api/admin/tips (spec §6 gate 3) and the Tip button's tips-live lookup. Locked here: only an
// admin approves; an approval lands only on the exact account the admin was shown; and the public
// "taking tips" flag needs every condition checkout needs, including the current owner.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type FakeDb } from './fake-supabase';

let db: FakeDb;
const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(),
  sendTipsApprovedEmail: vi.fn(), purgeCacheTags: vi.fn(),
}));
vi.mock('../notifications', () => ({ sendTipsApprovedEmail: mocks.sendTipsApprovedEmail }));
vi.mock('../purge-cache', () => ({ purgeCacheTags: mocks.purgeCacheTags }));
vi.mock('../db', () => ({ getClient: () => db.client }));
vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: mocks.authenticateAdmin,
}));
vi.mock('../../lib/sentry', () => ({ withSentry: (handler: unknown) => handler, Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage } }));

import { handler } from '../admin-tips';
import { getTipsLiveSlugs } from '../tips-db';

const ARTIST = '33333333-3333-4333-8333-333333333333';
const fetchMock = vi.fn();
const post = (body: unknown) => handler({ httpMethod: 'POST', headers: { authorization: 'Bearer admin' }, body: JSON.stringify(body) });

const liveRow = (overrides: Record<string, unknown> = {}) => ({
  artist_id: ARTIST, livemode: false, stripe_account_id: 'acct_artist', user_id: 'owner-1',
  charges_enabled: true, tips_enabled: true, tips_approved_at: '2026-09-01', fee_basis_points: 0,
  artists: { slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', match_confidence: 'claimed', artist_profiles: { user_id: 'owner-1', verified_at: '2026-01-01', email: 'o@example.com' } },
  ...overrides,
});

beforeEach(() => {
  db = createFakeDb();
  vi.resetAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({ userId: 'admin', email: 'admin@example.com' });
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'acct_artist', country: 'US', business_profile: { name: 'Kid Lightbulbs LLC' } })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

describe('admin-tips', () => {
  it('is admin-only', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    expect((await handler({ httpMethod: 'GET', headers: {}, body: null })).statusCode).toBe(401);
    expect((await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_artist' })).statusCode).toBe(401);
  });

  it('lists accounts with the Stripe side of the comparison', async () => {
    db.tables.artist_tip_accounts = [liveRow({ tips_approved_at: null })];
    const body = JSON.parse((await handler({ httpMethod: 'GET', headers: {}, body: null })).body);
    expect(body.accounts[0]).toMatchObject({
      artistName: 'Kid Lightbulbs', claimEmail: 'o@example.com', connectedByCurrentOwner: true,
      stripe: { businessName: 'Kid Lightbulbs LLC', country: 'US' }, state: 'awaiting_approval',
    });
  });

  const seedOwner = (profile: Record<string, unknown> = {}) => {
    db.tables.artists = [{ id: ARTIST, name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }];
    db.tables.artist_profiles = [{ artist_id: ARTIST, user_id: 'owner-1', verified_at: '2026-01-01', ...profile }];
  };

  it('approves only the account the admin was shown', async () => {
    seedOwner();
    db.tables.artist_tip_accounts = [liveRow({ tips_approved_at: null })];
    expect((await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_different' })).statusCode).toBe(409);
    expect(db.tables.artist_tip_accounts[0].tips_approved_at).toBeNull();
    expect((await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_artist' })).statusCode).toBe(200);
    expect(db.tables.artist_tip_accounts[0].tips_approved_at).toEqual(expect.any(String));
  });

  it('emails the artist once approved, and purges their cached page', async () => {
    seedOwner();
    db.tables.artist_tip_accounts = [liveRow({ tips_approved_at: null })];
    await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_artist' });
    expect(mocks.sendTipsApprovedEmail).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1', artistName: 'Kid Lightbulbs', slug: 'kid-lightbulbs', referenceId: expect.stringMatching(/^acct_artist:/),
    }));
    expect(mocks.purgeCacheTags).toHaveBeenCalledWith(['artist-kid-lightbulbs'], 'AdminTips');
    // A second click is a no-op: no second email.
    expect((await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_artist' })).statusCode).toBe(200);
    expect(mocks.sendTipsApprovedEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Stripe hasn’t enabled charges', { charges_enabled: false }, {}],
    ['the account was disconnected', { deauthorized_at: '2026-10-01' }, {}],
    ['the profile changed hands', {}, { user_id: 'new-owner' }],
    ['the claim isn’t verified', {}, { verified_at: null }],
  ])('refuses to approve when %s', async (_label, accountOverrides, profileOverrides) => {
    seedOwner(profileOverrides);
    db.tables.artist_tip_accounts = [liveRow({ tips_approved_at: null, ...accountOverrides })];
    const res = await post({ action: 'approve', artistId: ARTIST, stripeAccountId: 'acct_artist' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toEqual(expect.any(String));
    expect(db.tables.artist_tip_accounts[0].tips_approved_at).toBeNull();
    expect(mocks.sendTipsApprovedEmail).not.toHaveBeenCalled();
  });

  it('revokes: approval cleared and tips switched off', async () => {
    db.tables.artist_tip_accounts = [liveRow()];
    await post({ action: 'revoke', artistId: ARTIST });
    expect(db.tables.artist_tip_accounts[0]).toMatchObject({ tips_approved_at: null, tips_enabled: false });
  });
});

describe('getTipsLiveSlugs', () => {
  it('includes an artist meeting every condition', async () => {
    db.tables.artist_tip_accounts = [liveRow()];
    expect(await getTipsLiveSlugs(['kid-lightbulbs'])).toEqual(new Set(['kid-lightbulbs']));
  });

  it.each([
    ['unapproved', { tips_approved_at: null }],
    ['switched off', { tips_enabled: false }],
    ['not charge-enabled', { charges_enabled: false }],
    ['the other mode', { livemode: true }],
    ['disconnected in Stripe', { deauthorized_at: '2026-10-01' }],
  ])('excludes an account that is %s', async (_label, overrides) => {
    db.tables.artist_tip_accounts = [liveRow(overrides)];
    expect((await getTipsLiveSlugs(['kid-lightbulbs']))?.size).toBe(0);
  });

  it('excludes an account the current profile owner didn’t connect', async () => {
    db.tables.artist_tip_accounts = [liveRow({ user_id: 'previous-owner' })];
    expect((await getTipsLiveSlugs(['kid-lightbulbs']))?.size).toBe(0);
  });

  it('is empty, with no database read, when Stripe isn’t configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    db.tables.artist_tip_accounts = [liveRow()];
    expect((await getTipsLiveSlugs(['kid-lightbulbs']))?.size).toBe(0);
  });
});
