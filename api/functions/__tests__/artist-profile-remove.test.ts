import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// DELETE /api/artist-profile removes an artist's claim. It is the only destructive action an
// artist can take on their own profile, so these pin down that it can't be reached without
// ownership, that it doesn't delete another user's row, and that a page whose claim is gone
// doesn't stay flagged as claimed (which would freeze it — see db.ts getArtistBySlug).

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockResolveOwnedArtist: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  mockCacheDeleteByArtist: vi.fn(() => Promise.resolve()),
  mockCaptureException: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({ from: mocks.mockFrom }),
  resolveOwnedArtist: mocks.mockResolveOwnedArtist,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../cache', () => ({
  cacheDeleteByArtist: mocks.mockCacheDeleteByArtist,
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.mockCaptureException },
}));

import { handler } from '../artist-profile';

// The delete chain is `.delete({count}).eq(artist_id).eq(user_id)`; the artist revert is
// `.update(...).eq(id)`. One fake covers both tables and records what each was called with.
function mockTables(deleteResult: { error: unknown; count?: number }, revertError: unknown = null) {
  const deleteFn = vi.fn(() => {
    const chain = {
      eq: vi.fn(() => chain),
      then: (resolve: (v: unknown) => void) => resolve(deleteResult),
    };
    return chain;
  });
  const updateFn = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ error: revertError })),
  }));

  mocks.mockFrom.mockImplementation((table: string) =>
    table === 'artist_profiles' ? { delete: deleteFn } : { update: updateFn }
  );

  return { deleteFn, updateFn };
}

describe('artist-profile DELETE (remove claim)', () => {
  const deleteEvent = {
    httpMethod: 'DELETE',
    headers: { authorization: 'Bearer valid-token' },
    queryStringParameters: { slug: 'example-artist' },
    body: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.NETLIFY_SITE_ID;
    delete process.env.SITE_ID;
    delete process.env.NETLIFY_API_TOKEN;
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCacheDeleteByArtist.mockResolvedValue(undefined);
    mocks.mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'artist@example.com' } },
          error: null,
        }),
      },
    });
    mocks.mockResolveOwnedArtist.mockResolvedValue({
      ok: true,
      status: 200,
      artistId: 'artist-1',
      artistName: 'Example Artist',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without a token', async () => {
    const res = await handler({ ...deleteEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('returns 400 when slug is missing', async () => {
    const res = await handler({ ...deleteEvent, queryStringParameters: {} });
    expect(res!.statusCode).toBe(400);
  });

  it("returns 403 for someone else's profile", async () => {
    mocks.mockResolveOwnedArtist.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not own this profile',
    });
    const { deleteFn } = mockTables({ error: null, count: 1 });

    const res = await handler(deleteEvent);
    expect(res!.statusCode).toBe(403);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('deletes the profile scoped to the owner and reverts the artist to auto-discovered', async () => {
    const { deleteFn, updateFn } = mockTables({ error: null, count: 1 });

    const res = await handler(deleteEvent);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).success).toBe(true);

    expect(deleteFn).toHaveBeenCalledWith({ count: 'exact' });
    const deleteChain = deleteFn.mock.results[0].value as { eq: ReturnType<typeof vi.fn> };
    expect(deleteChain.eq).toHaveBeenCalledWith('artist_id', 'artist-1');
    expect(deleteChain.eq).toHaveBeenCalledWith('user_id', 'user-1');

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ match_confidence: 'unverified', source: 'auto' })
    );
    expect(mocks.mockCacheDeleteByArtist).toHaveBeenCalledWith('Example Artist');
  });

  it('returns 409 and leaves the artist row alone when nothing was deleted', async () => {
    const { updateFn } = mockTables({ error: null, count: 0 });

    const res = await handler(deleteEvent);
    expect(res!.statusCode).toBe(409);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('returns 500 without reverting the artist row when the delete fails', async () => {
    const { updateFn } = mockTables({ error: { message: 'boom' }, count: null as unknown as number });

    const res = await handler(deleteEvent);
    expect(res!.statusCode).toBe(500);
    expect(updateFn).not.toHaveBeenCalled();
    expect(mocks.mockCaptureException).toHaveBeenCalled();
  });

  it('reports a failed revert to Sentry but still confirms the removal', async () => {
    mockTables({ error: null, count: 1 }, { message: 'revert failed' });

    const res = await handler(deleteEvent);
    expect(res!.statusCode).toBe(200);
    expect(mocks.mockCaptureException).toHaveBeenCalled();
  });
});
