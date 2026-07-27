// Tests for authenticateBearerFast: local Supabase JWT verification with
// network fallback. Tokens are signed in-test with jose so no network or
// real Supabase project is involved.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const mocks = vi.hoisted(() => ({
  mockAuthGetUser: vi.fn(),
  mockCreateClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
vi.mock('../db', () => ({
  getClient: () => null,
}));

import { authenticateBearerFast } from '../middleware';

const SUPABASE_URL = 'https://test.supabase.co';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const secretKey = new TextEncoder().encode(JWT_SECRET);

async function signToken(overrides: {
  sub?: string;
  email?: string;
  aud?: string;
  iss?: string;
  exp?: string | number;
  secret?: Uint8Array;
} = {}): Promise<string> {
  const jwt = new SignJWT({ email: overrides.email ?? 'fan@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(overrides.sub ?? 'user-123')
    .setAudience(overrides.aud ?? 'authenticated')
    .setIssuer(overrides.iss ?? `${SUPABASE_URL}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '1h');
  return jwt.sign(overrides.secret ?? secretKey);
}

describe('authenticateBearerFast', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    mocks.mockCreateClient.mockReturnValue({
      auth: { getUser: mocks.mockAuthGetUser },
    });
  });

  it('verifies a valid token locally without calling the auth server', async () => {
    const token = await signToken();
    const user = await authenticateBearerFast(`Bearer ${token}`);
    expect(user).toEqual({ userId: 'user-123', email: 'fan@example.com' });
    expect(mocks.mockCreateClient).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed Authorization header', async () => {
    expect(await authenticateBearerFast(undefined)).toBeNull();
    expect(await authenticateBearerFast('Basic abc')).toBeNull();
    expect(await authenticateBearerFast('Bearer not-a-jwt')).toBeNull();
    expect(mocks.mockCreateClient).not.toHaveBeenCalled();
  });

  it('rejects an expired token without falling back', async () => {
    const token = await signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await authenticateBearerFast(`Bearer ${token}`)).toBeNull();
    expect(mocks.mockCreateClient).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signToken({
      secret: new TextEncoder().encode('a-completely-different-secret-of-32-chars!'),
    });
    expect(await authenticateBearerFast(`Bearer ${token}`)).toBeNull();
    expect(mocks.mockCreateClient).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience (e.g. the anon key)', async () => {
    const token = await signToken({ aud: 'anon' });
    expect(await authenticateBearerFast(`Bearer ${token}`)).toBeNull();
  });

  it('rejects a token from a different issuer/project', async () => {
    const token = await signToken({ iss: 'https://other-project.supabase.co/auth/v1' });
    expect(await authenticateBearerFast(`Bearer ${token}`)).toBeNull();
  });

  it('falls back to the auth server when SUPABASE_JWT_SECRET is not set', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-456', email: 'fallback@example.com' } },
      error: null,
    });

    const token = await signToken();
    const user = await authenticateBearerFast(`Bearer ${token}`);
    expect(user).toEqual({ userId: 'user-456', email: 'fallback@example.com' });
    expect(mocks.mockAuthGetUser).toHaveBeenCalledWith(token);
  });

  it('returns null when the fallback auth server rejects the token', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid token' },
    });

    const token = await signToken();
    expect(await authenticateBearerFast(`Bearer ${token}`)).toBeNull();
  });
});
