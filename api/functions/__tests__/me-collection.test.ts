import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadAllPages: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../db', () => ({
  getClient: () => ({ from: mocks.mockFrom }),
  readAllPages: mocks.mockReadAllPages,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-collection';

function authedEvent(method: string, body: unknown = null) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer valid-token' },
    body: body === null ? null : JSON.stringify(body),
  };
}

describe('me-collection handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
      },
    });
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null });
    expect(res!.statusCode).toBe(401);
  });

  it('GET returns the owner view including hidden items, via paged reads', async () => {
    const items = [
      { id: 'i-1', title: 'Illinois', hidden: false, provenance: 'purchased' },
      { id: 'i-2', title: 'Secret Album', hidden: true, provenance: 'purchased' },
    ];
    mocks.mockReadAllPages.mockResolvedValue({ ok: true, rows: items });

    const res = await handler(authedEvent('GET'));
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ items, total: 2 });
    // The paged reader is what guards PostgREST's silent 1,000-row cap.
    expect(mocks.mockReadAllPages).toHaveBeenCalled();
  });

  it('GET surfaces a failed read as an error, not an empty collection', async () => {
    mocks.mockReadAllPages.mockResolvedValue({ ok: false, reason: 'boom' });
    const res = await handler(authedEvent('GET'));
    expect(res!.statusCode).toBe(500);
  });

  it('POST validates the body', async () => {
    expect((await handler(authedEvent('POST', { hidden: true })))!.statusCode).toBe(400);
    expect((await handler(authedEvent('POST', { id: 'i-1', hidden: 'yes' })))!.statusCode).toBe(400);
  });

  it('POST scopes the hide toggle to the owner', async () => {
    const maybeSingle = vi.fn(() =>
      Promise.resolve({ data: { id: 'i-1', hidden: true }, error: null })
    );
    const select = vi.fn(() => ({ maybeSingle }));
    const userEq = vi.fn(() => ({ select }));
    const idEq = vi.fn(() => ({ eq: userEq }));
    const update = vi.fn(() => ({ eq: idEq }));
    mocks.mockFrom.mockReturnValue({ update });

    const res = await handler(authedEvent('POST', { id: 'i-1', hidden: true }));
    expect(res!.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({ hidden: true });
    expect(idEq).toHaveBeenCalledWith('id', 'i-1');
    expect(userEq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('POST 404s for an item the user does not own', async () => {
    const maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    mocks.mockFrom.mockReturnValue({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ select: vi.fn(() => ({ maybeSingle })) })),
        })),
      })),
    });
    const res = await handler(authedEvent('POST', { id: 'i-nope', hidden: true }));
    expect(res!.statusCode).toBe(404);
  });
});
