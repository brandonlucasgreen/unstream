// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockCreateClient: vi.fn(() => ({
      auth: {
        getUser: vi.fn(),
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

import { handler } from '../user-sharing';

describe('user-sharing handler', () => {
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

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('GET returns 404 when user has no username', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(404);
    expect(JSON.parse(res!.body).error).toContain('No username set');
  });

  it('GET returns sharing status when public', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { username: 'testuser', saved_artists_public: true },
            error: null,
          })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.public).toBe(true);
    expect(body.public_handle).toBe('testuser');
    expect(body.public_url).toBe('https://unstream.stream/u/testuser');
  });

  it('GET returns private status when not sharing', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { username: 'testuser', saved_artists_public: false },
            error: null,
          })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.public).toBe(false);
    expect(body.public_handle).toBeNull();
    expect(body.public_url).toBeNull();
  });

  it('POST returns 400 when public field is missing', async () => {
    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({}),
    });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('boolean');
  });

  it('POST returns 400 when no username is set', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ public: true }),
    });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('Set a username');
  });

  it('POST enables sharing (upsert + flag)', async () => {
    const maybeSingle = vi.fn(() => Promise.resolve({
      data: { username: 'testuser', saved_artists_public: false },
      error: null,
    }));
    const upsertFn = vi.fn(() => Promise.resolve({ error: null }));
    const updateFn = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));

    // 1st call: select username row
    // 2nd call: upsert user_public_ids
    // 3rd call: update saved_artists_public flag
    // 4th call: re-fetch for sharing check (after upsert)
    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle,
        })),
      })),
    }).mockReturnValueOnce({
      upsert: upsertFn,
    }).mockReturnValueOnce({
      update: updateFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ public: true }),
    });
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.public).toBe(true);
    expect(body.public_handle).toBe('testuser');
    expect(upsertFn).toHaveBeenCalled();
    expect(updateFn).toHaveBeenCalled();
  });

  it('POST disables sharing (delete + flag)', async () => {
    const maybeSingle = vi.fn(() => Promise.resolve({
      data: { username: 'testuser', saved_artists_public: true },
      error: null,
    }));
    const deleteFn = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    const updateFn = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));

    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle,
        })),
      })),
    }).mockReturnValueOnce({
      delete: deleteFn,
    }).mockReturnValueOnce({
      update: updateFn,
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ public: false }),
    });
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.public).toBe(false);
    expect(body.public_handle).toBeNull();
    expect(deleteFn).toHaveBeenCalled();
    expect(updateFn).toHaveBeenCalled();
  });

  it('POST rejects reserved handle', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { username: 'admin', saved_artists_public: false },
            error: null,
          })),
        })),
      })),
    });

    const res = await handler({
      ...validEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ public: true }),
    });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain('reserved');
  });
});