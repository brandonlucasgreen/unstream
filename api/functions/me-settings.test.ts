// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the db module so getClient returns a mock Supabase client
const mockFrom = vi.fn();
const mockAuthAdmin = {
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
};
const mockAuthGetUser = vi.fn();
const mockCreateClient = vi.fn(() => ({
  auth: {
    getUser: mockAuthGetUser,
    signInWithPassword: vi.fn(),
  },
}));
const mockCheckRateLimit = vi.fn(() => Promise.resolve({ limited: false }));
const mockGetClientIp = vi.fn(() => '127.0.0.1');

vi.mock('./db', () => ({
  getClient: () => ({
    from: mockFrom,
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

import { handler } from './me-settings';

describe('me-settings handler', () => {
  const validEvent = {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer valid-token' },
    body: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    mockCheckRateLimit.mockResolvedValue({ limited: false });
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
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

  it('returns settings with username, email, and hasPassword', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({
      data: { user: { email: 'test@example.com', user_metadata: { has_password: true } } },
      error: null,
    });
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { username: 'kidlightbulbs' }, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.username).toBe('kidlightbulbs');
    expect(body.email).toBe('test@example.com');
    expect(body.hasPassword).toBe(true);
  });

  it('returns null username when user has no username row', async () => {
    mockAuthAdmin.getUserById.mockResolvedValue({
      data: { user: { email: 'test@example.com', user_metadata: {} } },
      error: null,
    });
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.username).toBe(null);
    expect(body.hasPassword).toBe(false);
  });

  it('returns 404 for non-GET methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'POST' });
    expect(res!.statusCode).toBe(404);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });
});
