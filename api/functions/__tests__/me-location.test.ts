// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-location';

describe('me-location handler', () => {
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

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ ...validEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('GET returns location when set', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { location: 'Brooklyn, NY' }, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe('Brooklyn, NY');
  });

  it('GET returns null location when not set', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { location: null }, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe(null);
  });

  it('GET returns null location when no username row', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe(null);
  });

  it('POST upserts location for existing row', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: 'Paris, France' }),
    });
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe('Paris, France');
    expect(upsertFn).toHaveBeenCalled();
    expect(upsertFn).toHaveBeenCalledWith(
      { user_id: 'user-1', location: 'Paris, France' },
      { onConflict: 'user_id' }
    );
  });

  it('POST trims whitespace', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: '  Brooklyn, NY  ' }),
    });
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe('Brooklyn, NY');
  });

  it('POST clears location when empty string', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: '   ' }),
    });
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe(null);
  });

  it('POST clears location when null (existing row)', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: null }),
    });
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe(null);
    expect(upsertFn).toHaveBeenCalledWith(
      { user_id: 'user-1', location: null },
      { onConflict: 'user_id' }
    );
  });

  it('POST rejects location over 100 chars', async () => {
    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: 'x'.repeat(101) }),
    });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('100 characters');
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('returns 404 for non-GET/POST methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'DELETE' });
    expect(res!.statusCode).toBe(404);
  });

  // Regression tests: users without a usernames row (UNS-144 round 2)
  // The `usernames` table has `username` as NOT NULL, so upserting without it
  // fails with Postgres error 23502. The handler must detect this and respond
  // gracefully instead of returning a false success.

  it('POST returns 400 when setting location without a username row (23502)', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({
      error: { code: '23502', message: 'null value in column "username" violates not-null constraint' },
    }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: 'Boston' }),
    });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('username');
  });

  it('POST returns 200 when clearing location without a username row (23502)', async () => {
    const upsertFn = vi.fn(() => Promise.resolve({
      error: { code: '23502', message: 'null value in column "username" violates not-null constraint' },
    }));
    mocks.mockFrom.mockReturnValue({
      upsert: upsertFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ location: null }),
    });
    // Location is already effectively null — desired state achieved.
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).location).toBe(null);
  });
});