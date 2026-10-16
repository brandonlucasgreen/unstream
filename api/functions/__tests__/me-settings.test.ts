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

// The handler's return type is a union over its branches, so header access needs a cast.
function headersOf(response: { headers: unknown } | null | undefined): Record<string, string> {
  return response!.headers as Record<string, string>;
}

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

  // Two reads go out in parallel: usernames (select → eq → maybeSingle) and
  // email_change_requests (select → eq → gt → maybeSingle, the expiry filter from UNS-212
  // fix list item 3). One chain shape serves both.
  function stubTables(rows: { usernames?: unknown; emailChange?: unknown } = {}) {
    mocks.mockFrom.mockImplementation((table: string) => {
      const row = table === 'usernames'
        ? (rows.usernames ?? { data: null, error: null })
        : (rows.emailChange ?? { data: null, error: null });
      const maybeSingle = vi.fn().mockResolvedValue(row);
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle, gt: vi.fn(() => ({ maybeSingle })) })) })) };
    });
  }

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
    stubTables({ usernames: { data: { username: 'kidlightbulbs', location: 'Brooklyn, NY' }, error: null } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.username).toBe('kidlightbulbs');
    expect(body.location).toBe('Brooklyn, NY');
    expect(body.email).toBe('test@example.com');
    expect(body.hasPassword).toBe(true);
    expect(body.pendingEmailChange).toBe(null);
  });

  it('includes the pending email-change address when one exists', async () => {
    mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    });
    stubTables({ emailChange: { data: { new_email: 'new@example.com' }, error: null } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.pendingEmailChange).toBe('new@example.com');
    // The current email stays the primary until confirmation flips it.
    expect(body.email).toBe('test@example.com');
  });

  it('filters expired pending changes out of the read', async () => {
    // The row is gone (expired and swept, or never there): the read must not surface it, so
    // the query carries an expires_at filter rather than trusting a later cleanup pass.
    const gt = vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }));
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'email_change_requests') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ gt })) })) };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
        })),
      };
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).pendingEmailChange).toBe(null);
    expect(gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('tolerates a missing email_change_requests table (pre-merge preview)', async () => {
    // Until the migration lands with the merge, prod runs without the table. The pending
    // check failing there must NOT take down the whole settings payload (launch blocker
    // 2026-10-16: 500 + hidden email on the #609 preview) — 42P01 degrades to null.
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'email_change_requests') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              gt: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '42P01', message: 'relation "email_change_requests" does not exist' },
                }),
              })),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { username: 'kidlightbulbs', location: null },
              error: null,
            }),
          })),
        })),
      };
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.pendingEmailChange).toBe(null);
    expect(body.email).toBe('test@example.com');
    expect(body.username).toBe('kidlightbulbs');
  });

  it('returns null username and location when user has no username row', async () => {
    stubTables();

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.username).toBe(null);
    expect(body.location).toBe(null);
    expect(body.hasPassword).toBe(false);
  });

  it('returns 405 with an Allow header for non-GET methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'POST' });
    expect(res!.statusCode).toBe(405);
    expect(headersOf(res).Allow).toBe('GET, OPTIONS');
  });

  it('scopes Access-Control-Allow-Origin to the site allowlist, never a wildcard', async () => {
    stubTables();

    const unknownOrigin = await handler({
      ...validEvent,
      headers: { ...validEvent.headers, origin: 'https://evil.example' },
    });
    expect(headersOf(unknownOrigin)['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
    expect(headersOf(unknownOrigin)['Access-Control-Allow-Origin']).not.toBe('*');
    // Bearer-token endpoints must not invite credentials.
    expect(headersOf(unknownOrigin)['Access-Control-Allow-Credentials']).toBeUndefined();

    const devOrigin = await handler({
      ...validEvent,
      headers: { ...validEvent.headers, origin: 'http://localhost:8888' },
    });
    expect(headersOf(devOrigin)['Access-Control-Allow-Origin']).toBe('http://localhost:8888');
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });
});
