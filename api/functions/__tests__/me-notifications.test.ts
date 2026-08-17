import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(() => ({ auth: { getUser: vi.fn() } })),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../db', () => ({ getClient: () => ({ from: mocks.mockFrom }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
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

import { handler } from '../me-notifications';

const DEFAULTS = { newRelease: true, newPlatformLink: true, weeklyAnalyticsRecap: true };

describe('me-notifications handler', () => {
  const validEvent = {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer valid-token' },
    body: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
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

  it('returns 401 when the token was checked and rejected, not just absent', async () => {
    const res = await handler({ ...validEvent, headers: { authorization: REJECTED_TOKEN } });
    expect(res!.statusCode).toBe(401);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ ...validEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('GET returns all-enabled defaults when the user has no row yet', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual(DEFAULTS);
  });

  it('GET returns the stored toggles when a row exists', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { new_release: false, new_platform_link: true, weekly_analytics_recap: false },
            error: null,
          })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({
      newRelease: false,
      newPlatformLink: true,
      weeklyAnalyticsRecap: false,
    });
  });

  it('GET reports a database error rather than silently claiming defaults', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
  });

  it('POST upserts only the provided field and returns the full resulting state', async () => {
    const upsertFn = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { new_release: false, new_platform_link: true, weekly_analytics_recap: true },
          error: null,
        })),
      })),
    }));
    mocks.mockFrom.mockReturnValue({ upsert: upsertFn });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ newRelease: false }),
    });

    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ newRelease: false, newPlatformLink: true, weeklyAnalyticsRecap: true });
    expect(upsertFn).toHaveBeenCalledWith(
      { user_id: 'user-1', new_release: false },
      { onConflict: 'user_id' },
    );
  });

  it('POST accepts multiple fields at once', async () => {
    const upsertFn = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { new_release: false, new_platform_link: false, weekly_analytics_recap: true },
          error: null,
        })),
      })),
    }));
    mocks.mockFrom.mockReturnValue({ upsert: upsertFn });

    await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ newRelease: false, newPlatformLink: false }),
    });

    expect(upsertFn).toHaveBeenCalledWith(
      { user_id: 'user-1', new_release: false, new_platform_link: false },
      { onConflict: 'user_id' },
    );
  });

  it('POST rejects a non-boolean field', async () => {
    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ newRelease: 'yes' }),
    });
    expect(res!.statusCode).toBe(400);
  });

  it('POST rejects a body with no recognized fields', async () => {
    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ somethingElse: true }),
    });
    expect(res!.statusCode).toBe(400);
  });

  it('POST rejects invalid JSON', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'POST', body: '{not json' });
    expect(res!.statusCode).toBe(400);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('returns 404 for non-GET/POST methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'DELETE' });
    expect(res!.statusCode).toBe(404);
  });
});
