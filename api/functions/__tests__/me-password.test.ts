// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockAuthAdmin: {
      getUserById: vi.fn(),
      updateUserById: vi.fn(),
      mfa: {
        listFactors: vi.fn(),
      },
    },
    mockSignInWithPassword: vi.fn(),
    mockCreateClient: vi.fn(() => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'test@example.com' } },
          error: null,
        }),
        signInWithPassword: vi.fn(),
      },
    })),
    mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
    mockGetClientIp: vi.fn(() => '127.0.0.1'),
  };
});

// A JWT-shaped access token whose payload carries the given claims, so the
// aal2 path can be exercised without the real signing key — me-password only
// decodes the payload; the token was verified by getUser, mocked above.
function tokenWithClaims(payload: Record<string, unknown>): string {
  const part = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.sig`;
}

vi.mock('../db', () => ({
  getClient: () => ({
    auth: { admin: mocks.mockAuthAdmin },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-password';

describe('me-password handler', () => {
  const validEvent = {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify({ current_password: 'oldpass123', new_password: 'newpass123' }),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'test@example.com' } },
          error: null,
        }),
        signInWithPassword: mocks.mockSignInWithPassword,
      },
    });
    // No factors by default: the common account has no second step, and
    // 'valid-token' is not a decodable JWT, so its session reads as aal1.
    mocks.mockAuthAdmin.mfa.listFactors.mockResolvedValue({
      data: { factors: [] },
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ ...validEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('rejects missing current_password', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ new_password: 'newpass123' }) });
    expect(res!.statusCode).toBe(400);
  });

  it('rejects new_password shorter than 8 chars', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ current_password: 'oldpass123', new_password: 'short' }) });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('at least 8 characters');
  });

  it('rejects wrong current password', async () => {
    mocks.mockSignInWithPassword.mockResolvedValue({ error: { message: 'Invalid credentials' } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toBe('Current password is incorrect');
  });

  it('uses strict rate limit tier', async () => {
    mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
    mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

    await handler(validEvent);
    expect(mocks.mockCheckRateLimit).toHaveBeenCalledWith(expect.any(String), 'strict', expect.any(Object));
  });

  it('updates password with user_metadata (snake_case) on success', async () => {
    mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
    mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).success).toBe(true);

    expect(mocks.mockAuthAdmin.updateUserById).toHaveBeenCalledWith('user-1', {
      password: 'newpass123',
      user_metadata: { has_password: true },
    });
  });

  it('returns 500 when update fails', async () => {
    mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
    mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: { message: 'DB error' } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  describe('two-step verification (defense in depth)', () => {
    it('refuses an aal1 session when the account has a verified factor, without touching the password', async () => {
      mocks.mockAuthAdmin.mfa.listFactors.mockResolvedValue({
        data: { factors: [{ id: 'f1', status: 'verified' }] },
        error: null,
      });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(403);
      expect(JSON.parse(res!.body).error).toContain('two-step verification');
      expect(mocks.mockSignInWithPassword).not.toHaveBeenCalled();
      expect(mocks.mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
    });

    it('proceeds at aal1 when the account has no factors', async () => {
      mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
      mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(200);
      expect(mocks.mockAuthAdmin.mfa.listFactors).toHaveBeenCalledTimes(1);
      expect(mocks.mockAuthAdmin.updateUserById).toHaveBeenCalledTimes(1);
    });

    it('treats an unverified factor as no second step', async () => {
      mocks.mockAuthAdmin.mfa.listFactors.mockResolvedValue({
        data: { factors: [{ id: 'f1', status: 'unverified' }] },
        error: null,
      });
      mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
      mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(200);
    });

    it('does not ask about factors at all when the session completed the second step (aal2)', async () => {
      mocks.mockSignInWithPassword.mockResolvedValue({ error: null });
      mocks.mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

      const res = await handler({
        ...validEvent,
        headers: { authorization: `Bearer ${tokenWithClaims({ sub: 'user-1', aal: 'aal2' })}` },
      });
      expect(res!.statusCode).toBe(200);
      expect(mocks.mockAuthAdmin.mfa.listFactors).not.toHaveBeenCalled();
    });

    it('fails closed when the factor lookup errors', async () => {
      mocks.mockAuthAdmin.mfa.listFactors.mockResolvedValue({
        data: null,
        error: { message: 'supabase down' },
      });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(500);
      expect(mocks.mockSignInWithPassword).not.toHaveBeenCalled();
      expect(mocks.mockAuthAdmin.updateUserById).not.toHaveBeenCalled();
    });
  });

  it('never logs password values', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    mocks.mockSignInWithPassword.mockResolvedValue({ error: { message: 'fail' } });

    await handler(validEvent);
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).not.toContain('oldpass123');
    expect(allCalls).not.toContain('newpass123');
    consoleSpy.mockRestore();
  });
});