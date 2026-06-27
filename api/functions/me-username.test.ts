// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFrom = vi.fn();
const mockCreateClient = vi.fn(() => ({
  auth: {
    getUser: vi.fn(),
    signInWithPassword: vi.fn(),
  },
})) as any;
const mockCheckRateLimit = vi.fn(() => Promise.resolve({ limited: false }));
const mockGetClientIp = vi.fn(() => '127.0.0.1');

vi.mock('./db', () => ({
  getClient: () => ({
    from: mockFrom,
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));
vi.mock('./ratelimit', () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: mockGetClientIp,
}));

import { handler } from './me-username';

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
    mockCheckRateLimit.mockResolvedValue({ limited: false });
    // Default auth mock
    mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'test@example.com' } },
          error: null,
        }),
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
    mockFrom.mockReturnValue({
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
    // First select: user's existing username (different from requested)
    // Second select: conflict check finds a row
    const maybeSingle1 = vi.fn(() => Promise.resolve({ data: { username: 'oldname' }, error: null }));
    const maybeSingle2 = vi.fn(() => Promise.resolve({ data: { user_id: 'other-user' }, error: null }));

    mockFrom.mockReturnValueOnce({
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

    mockFrom.mockReturnValueOnce({
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
