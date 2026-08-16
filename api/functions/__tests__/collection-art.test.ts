import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  mockCoverArtId: vi.fn(),
  mockFetchCoverArt: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => ({ from: mocks.mockFrom }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  accountRateLimitKey: async () => 'user:test-user',
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../bandcamp-subsonic', async importOriginal => {
  const original = await importOriginal<typeof import('../bandcamp-subsonic')>();
  return {
    ...original,
    subsonicAlbumCoverArtId: mocks.mockCoverArtId,
    subsonicFetchCoverArt: mocks.mockFetchCoverArt,
  };
});

import { handler } from '../collection-art';
import { encryptCredential } from '../credential-crypto';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'user-owner';

interface Setup {
  item?: Record<string, unknown> | null;
  sharingPublic?: boolean;
  hasConnection?: boolean;
}

function setupDb({ item, sharingPublic = false, hasConnection = true }: Setup) {
  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'collection_items') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: item ?? null, error: null })) })),
        })),
      };
    }
    if (table === 'usernames') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: { saved_artists_public: sharingPublic }, error: null })),
          })),
        })),
      };
    }
    if (table === 'bandcamp_connections') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() =>
              Promise.resolve({
                data: hasConnection
                  ? {
                      bandcamp_username: 'fan',
                      credential_ciphertext: encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' })),
                    }
                  : null,
                error: null,
              })
            ),
          })),
        })),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const PUBLIC_ITEM = { user_id: OWNER, external_id: 'al-1', provenance: 'purchased', hidden: false };

function get(headers: Record<string, string | undefined> = {}) {
  return handler({ httpMethod: 'GET', headers, pathParameters: { id: ITEM_ID } });
}

function signedInAs(userId: string | null) {
  mocks.mockCreateClient.mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue(
        userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: 'bad token' }
      ),
    },
  });
}

describe('collection-art handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.BANDCAMP_CREDENTIAL_KEY = randomBytes(32).toString('base64');
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    signedInAs(null);
    mocks.mockCoverArtId.mockResolvedValue('art-1');
    mocks.mockFetchCoverArt.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'image/jpeg',
    });
  });

  afterEach(() => {
    delete process.env.BANDCAMP_CREDENTIAL_KEY;
  });

  it('rejects a malformed item id without touching the database', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, pathParameters: { id: '../secrets' } });
    expect(res.statusCode).toBe(400);
    expect(mocks.mockFrom).not.toHaveBeenCalled();
  });

  it('serves art for a public item on a shared page', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: true });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.isBase64Encoded).toBe(true);
    // Cached hard at the CDN so one page view doesn't re-hit Bandcamp per tile.
    expect(res.headers['Netlify-CDN-Cache-Control']).toContain('s-maxage=2592000');
  });

  it('refuses a public request when the owner has not shared their page', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: false });
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(mocks.mockFetchCoverArt).not.toHaveBeenCalled();
  });

  it('refuses a public request for a hidden item, matching the page it appears on', async () => {
    setupDb({ item: { ...PUBLIC_ITEM, hidden: true }, sharingPublic: true });
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(mocks.mockFetchCoverArt).not.toHaveBeenCalled();
  });

  it('refuses a public request for a non-purchased item', async () => {
    setupDb({ item: { ...PUBLIC_ITEM, provenance: 'listened' }, sharingPublic: true });
    expect((await get()).statusCode).toBe(404);
  });

  it('serves the owner their own hidden item even with sharing off', async () => {
    setupDb({ item: { ...PUBLIC_ITEM, hidden: true }, sharingPublic: false });
    signedInAs(OWNER);
    const res = await get({ authorization: 'Bearer owner-token' });
    expect(res.statusCode).toBe(200);
  });

  it('does not let one signed-in user read another user\'s private art', async () => {
    setupDb({ item: { ...PUBLIC_ITEM, hidden: true }, sharingPublic: false });
    signedInAs('someone-else');
    const res = await get({ authorization: 'Bearer other-token' });
    expect(res.statusCode).toBe(404);
    expect(mocks.mockFetchCoverArt).not.toHaveBeenCalled();
  });

  it('404s briefly — not permanently — when Bandcamp has no art', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: true });
    mocks.mockCoverArtId.mockResolvedValue(null);
    const res = await get();
    expect(res.statusCode).toBe(404);
    // A month-long cache would freeze a transient upstream failure into a permanent gap.
    expect(res.headers['Netlify-CDN-Cache-Control']).toContain('s-maxage=300');
  });

  it('404s rather than throwing when Bandcamp errors', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: true });
    mocks.mockFetchCoverArt.mockRejectedValue(new Error('upstream exploded'));
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.headers['Netlify-CDN-Cache-Control']).toContain('s-maxage=300');
  });

  it('404s when the owner has disconnected Bandcamp', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: true, hasConnection: false });
    expect((await get()).statusCode).toBe(404);
  });

  it('never returns credential material in a response body', async () => {
    setupDb({ item: PUBLIC_ITEM, sharingPublic: true, hasConnection: false });
    const res = await get();
    expect(res.body).not.toContain('tok');
    expect(res.body).not.toContain('salt');
    expect(res.body).not.toContain('ciphertext');
  });
});
