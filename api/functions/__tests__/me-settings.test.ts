// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockAuthAdmin: {
      getUserById: vi.fn(),
      updateUserById: vi.fn(),
    },
    mockAuthGetUser: vi.fn(),
    mockCreateClient: vi.fn(() => ({
      auth: {
        getUser: vi.fn(),
        signInWithPassword: vi.fn(),
      },
    })),
    mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
    mockGetClientIp: vi.fn(() => '127.0.0.1'),
  };
});

vi.mock('../db', () => ({
  getClient: () => ({
    from: mocks.mockFrom,
    auth: { admin: mocks.mockAuthAdmin },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  accountRateLimitKey: async () => 'user:test-user',
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-settings';

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
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    });
    mocks.mockCreateClient.mockReturnValue({
      auth: {
        getUser: mocks.mockAuthGetUser,
        signInWithPassword: vi.fn(),
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

  it('returns settings with username, location, email, and hasPassword', async () => {
    // has_password comes from the token-validation response (auth.getUser),
    // not a separate admin.getUserById lookup.
    mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com', user_metadata: { has_password: true } } },
      error: null,
    });
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { username: 'kidlightbulbs', location: 'Brooklyn, NY' }, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.username).toBe('kidlightbulbs');
    expect(body.location).toBe('Brooklyn, NY');
    expect(body.email).toBe('test@example.com');
    expect(body.hasPassword).toBe(true);
  });

  it('returns null username and location when user has no username row', async () => {
    mocks.mockFrom.mockReturnValue({
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
    expect(body.location).toBe(null);
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