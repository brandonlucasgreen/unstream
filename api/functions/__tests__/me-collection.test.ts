import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadAllPages: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
}));

// Real artistSlug — see the note in public-saved-artists.test.ts.
vi.mock('../db', async importOriginal => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    getClient: () => ({ from: mocks.mockFrom }),
    readAllPages: mocks.mockReadAllPages,
    artistSlug: actual.artistSlug,
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  accountRateLimitKey: async () => 'user:test-user',
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
    mocks.mockReadAllPages.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'i-1',
          title: 'Illinois',
          artist_name: 'Sufjan Stevens',
          art_url: null,
          hidden: false,
          provenance: 'purchased',
          releases: { slug: 'illinois', artwork_url: 'https://f4.bcbits.com/a.jpg', artists: { slug: 'sufjan-stevens' } },
        },
        {
          id: 'i-2',
          title: 'Secret Album',
          artist_name: 'Nobody We Know',
          art_url: null,
          hidden: true,
          provenance: 'purchased',
          releases: null,
        },
      ],
    });
    // No artist rows exist for the unmatched item's artist.
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
    });

    const res = await handler(authedEvent('GET'));
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.total).toBe(2);
    // Hidden items belong in the owner's view — the public page is what filters them.
    expect(body.items.map((i: { hidden: boolean }) => i.hidden)).toEqual([false, true]);
    // Matched item: art and links from the joined release.
    expect(body.items[0]).toMatchObject({
      art_url: 'https://f4.bcbits.com/a.jpg',
      url: '/a/sufjan-stevens/illinois',
      artist_url: '/a/sufjan-stevens',
    });
    // Unmatched item: art falls back to the proxy, and nothing is linked.
    expect(body.items[1]).toMatchObject({
      art_url: '/api/collection/art/i-2',
      url: null,
      artist_url: null,
    });
    // The join column is dropped rather than echoed back to the client.
    expect(body.items[0].releases).toBeUndefined();
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
