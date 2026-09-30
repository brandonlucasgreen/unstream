import { describe, it, expect, vi, beforeEach } from 'vitest';

// PUT /api/artist-profile { showBio } — a claimed artist turning the search-result bio off.
// Pins down that it saves for the owner, can't be reached by anyone else, and that a bad
// value is refused before anything is written.

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockCacheDeleteByArtist: vi.fn(() => Promise.resolve()),
}));

vi.mock('../db', () => ({
  getClient: () => ({ from: mocks.mockFrom }),
  resolveOwnedArtist: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../cache', () => ({ cacheDeleteByArtist: mocks.mockCacheDeleteByArtist }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { handler } from '../artist-profile';

function single(data: unknown) {
  const chain = { select: () => chain, eq: () => chain, single: () => Promise.resolve({ data, error: null }) };
  return chain;
}

function mockTables(ownerId: string) {
  const profileUpdate = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'artists') return single({ id: 'artist-1', name: 'Example Artist', slug: 'example-artist' });
    return { ...single({ id: 'profile-1', user_id: ownerId, verified_at: '2026-01-01' }), update: profileUpdate };
  });
  return { profileUpdate };
}

function put(body: unknown) {
  return handler({
    httpMethod: 'PUT',
    headers: { authorization: 'Bearer valid-token' },
    queryStringParameters: null,
    body: JSON.stringify(body),
  } as Parameters<typeof handler>[0]);
}

describe('artist-profile PUT showBio', () => {
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
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@example.com' } }, error: null }),
      },
    });
  });

  it('saves the setting for the owner', async () => {
    const { profileUpdate } = mockTables('user-1');
    const response = await put({ slug: 'example-artist', showBio: false });
    expect(response.statusCode).toBe(200);
    expect(profileUpdate).toHaveBeenCalledWith(expect.objectContaining({ show_bio: false }));
  });

  it("refuses someone else's profile", async () => {
    const { profileUpdate } = mockTables('someone-else');
    const response = await put({ slug: 'example-artist', showBio: false });
    expect(response.statusCode).toBe(403);
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it('refuses a non-boolean before writing anything', async () => {
    const { profileUpdate } = mockTables('user-1');
    const response = await put({ slug: 'example-artist', bio: 'New bio', showBio: 'no' });
    expect(response.statusCode).toBe(400);
    expect(profileUpdate).not.toHaveBeenCalled();
  });
});
