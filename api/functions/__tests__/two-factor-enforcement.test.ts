import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two-step verification on the server (middleware.ts). The web app's MfaChallengeGate
// is only UI: these pin down that the API itself refuses an aal1 session for an
// account with a verified factor, wherever it acts as an artist, admin or key holder.

const mocks = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.mockGetUser } }),
}));
vi.mock('../db', () => ({ getClient: () => null }));

import {
  authenticateAdmin,
  authenticateBearer,
  isMissingSecondFactor,
  sessionMissingSecondFactor,
} from '../middleware';

/** A token-shaped string carrying only the claims these checks read; nothing verifies its signature here. */
function tokenWithAal(aal: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', aal })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

const AAL1 = tokenWithAal('aal1');
const AAL2 = tokenWithAal('aal2');
const withFactor = { id: 'user-1', email: 'artist@example.com', factors: [{ status: 'verified' }] };
const withoutFactor = { id: 'user-1', email: 'artist@example.com' };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.ADMIN_EMAIL = 'artist@example.com';
});

describe('isMissingSecondFactor', () => {
  it('is false for an account with no verified factor, whatever the session', () => {
    expect(isMissingSecondFactor(withoutFactor, AAL1)).toBe(false);
    expect(isMissingSecondFactor({ factors: [{ status: 'unverified' }] }, AAL1)).toBe(false);
  });

  it('is true for an aal1 session on an account with a verified factor', () => {
    expect(isMissingSecondFactor(withFactor, AAL1)).toBe(true);
  });

  it('is false once the session has completed the factor', () => {
    expect(isMissingSecondFactor(withFactor, AAL2)).toBe(false);
  });

  it('fails closed on a token whose aal it cannot read', () => {
    expect(isMissingSecondFactor(withFactor, 'not-a-jwt')).toBe(true);
  });
});

describe('authenticateBearer', () => {
  it('refuses an aal1 session for an account with a verified factor', async () => {
    mocks.mockGetUser.mockResolvedValue({ data: { user: withFactor }, error: null });
    expect(await authenticateBearer(`Bearer ${AAL1}`)).toBeNull();
    expect(await authenticateAdmin(`Bearer ${AAL1}`)).toBeNull();
  });

  it('accepts the same account at aal2', async () => {
    mocks.mockGetUser.mockResolvedValue({ data: { user: withFactor }, error: null });
    expect(await authenticateBearer(`Bearer ${AAL2}`)).toEqual({ userId: 'user-1', email: 'artist@example.com' });
  });

  it('accepts aal1 for an account without a second factor', async () => {
    mocks.mockGetUser.mockResolvedValue({ data: { user: withoutFactor }, error: null });
    expect(await authenticateBearer(`Bearer ${AAL1}`)).toEqual({ userId: 'user-1', email: 'artist@example.com' });
  });
});

describe('sessionMissingSecondFactor', () => {
  it('answers an aal2 token without asking Supabase', async () => {
    expect(await sessionMissingSecondFactor(`Bearer ${AAL2}`)).toBe(false);
    expect(mocks.mockGetUser).not.toHaveBeenCalled();
  });

  it('looks up the factors for an aal1 token', async () => {
    mocks.mockGetUser.mockResolvedValue({ data: { user: withFactor }, error: null });
    expect(await sessionMissingSecondFactor(`Bearer ${AAL1}`)).toBe(true);

    mocks.mockGetUser.mockResolvedValue({ data: { user: withoutFactor }, error: null });
    expect(await sessionMissingSecondFactor(`Bearer ${AAL1}`)).toBe(false);
  });

  it('fails closed when Supabase cannot answer', async () => {
    mocks.mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'upstream down' } });
    expect(await sessionMissingSecondFactor(`Bearer ${AAL1}`)).toBe(true);
  });

  it('refuses a missing header', async () => {
    expect(await sessionMissingSecondFactor(undefined)).toBe(true);
  });
});
