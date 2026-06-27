// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockAuthAdmin: {
      getUserById: vi.fn(),
      updateUserById: vi.fn(),
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

vi.mock('./db', () => ({
  getClient: () => ({
    auth: { admin: mocks.mockAuthAdmin },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
vi.mock('./ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from './me-password';

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