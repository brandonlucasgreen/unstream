// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
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
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
/** An Authorization header whose token does not verify — see the ratelimit mock below. */
const REJECTED_TOKEN = 'Bearer rejected-token';

vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  // Mirrors the real helper: deriving the bucket verifies the token, so a request that
  // carries a good one resolves to a user. A missing header and the REJECTED_TOKEN sentinel
  // both resolve to null — the second is how a test says "header present, signature bad",
  // which is the case an auth regression would actually hide. Treating every truthy header
  // as authenticated would let such a test pass without exercising anything.
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader && authHeader !== REJECTED_TOKEN
      ? { key: 'user:test-user', user: { userId: 'user-1', email: 'test@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-username';

describe('me-username handler', () => {
  const validEvent = {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify({ username: 'newuser' }),
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
        signInWithPassword: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the token was checked and rejected, not just absent', async () => {
    const res = await handler({ ...validEvent, headers: { authorization: REJECTED_TOKEN } });
    expect(res!.statusCode).toBe(401);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ ...validEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('rejects missing username', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({}) });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('Username is required');
  });

  it('rejects invalid username format', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ username: 'AB' }) });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('3-20 characters');
  });

  it('returns 200 with same username when unchanged (no-op)', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { username: 'newuser' }, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).username).toBe('newuser');
  });

  it('returns 409 when username is taken', async () => {
    const maybeSingle1 = vi.fn(() => Promise.resolve({ data: { username: 'oldname' }, error: null }));
    const maybeSingle2 = vi.fn(() => Promise.resolve({ data: { user_id: 'other-user' }, error: null }));

    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingle1,
        })),
      })),
    }).mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            maybeSingle: maybeSingle2,
          })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(409);
    expect(JSON.parse(res!.body).error).toBe('Username is already taken');
  });

  it('returns 200 on successful upsert', async () => {
    const maybeSingle1 = vi.fn(() => Promise.resolve({ data: { username: 'oldname' }, error: null }));
    const maybeSingle2 = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));

    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingle1,
        })),
      })),
    }).mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            maybeSingle: maybeSingle2,
          })),
        })),
      })),
    }).mockReturnValueOnce({
      upsert: upsertFn,
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).username).toBe('newuser');
    expect(upsertFn).toHaveBeenCalled();
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });
});