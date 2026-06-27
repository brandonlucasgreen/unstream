// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAuthAdmin = {
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
};
const mockSignInWithPassword = vi.fn();
const mockCreateClient = vi.fn(() => ({
  auth: {
    getUser: vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    }),
    signInWithPassword: mockSignInWithPassword,
  },
}));
const mockCheckRateLimit = vi.fn(() => Promise.resolve({ limited: false }));
const mockGetClientIp = vi.fn(() => '127.0.0.1');

vi.mock('./db', () => ({
  getClient: () => ({
    auth: { admin: mockAuthAdmin },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));
vi.mock('./ratelimit', () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: mockGetClientIp,
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
    mockCheckRateLimit.mockResolvedValue({ limited: false });
    mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'test@example.com' } },
          error: null,
        }),
        signInWithPassword: mockSignInWithPassword,
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
    mockSignInWithPassword.mockResolvedValue({ error: { message: 'Invalid credentials' } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toBe('Current password is incorrect');
  });

  it('uses strict rate limit tier', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

    await handler(validEvent);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.any(String), 'strict', expect.any(Object));
  });

  it('updates password with user_metadata (snake_case) on success', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    mockAuthAdmin.updateUserById.mockResolvedValue({ error: null });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).success).toBe(true);

    // Verify the admin API was called with user_metadata (not userMetadata)
    expect(mockAuthAdmin.updateUserById).toHaveBeenCalledWith('user-1', {
      password: 'newpass123',
      user_metadata: { has_password: true },
    });
  });

  it('returns 500 when update fails', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    mockAuthAdmin.updateUserById.mockResolvedValue({ error: { message: 'DB error' } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('never logs password values', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    mockSignInWithPassword.mockResolvedValue({ error: { message: 'fail' } });

    await handler(validEvent);
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).not.toContain('oldpass123');
    expect(allCalls).not.toContain('newpass123');
    consoleSpy.mockRestore();
  });
});
