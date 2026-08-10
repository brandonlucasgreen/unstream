// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockReadAllPages: vi.fn(),
    mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
    mockGetClientIp: vi.fn(() => '127.0.0.1'),
  };
});

vi.mock('../db', () => ({
  getClient: () => ({
    from: mocks.mockFrom,
  }),
  readAllPages: mocks.mockReadAllPages,
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../public-saved-artists';

describe('public-saved-artists handler', () => {
  const validEvent = {
    httpMethod: 'GET',
    headers: {},
    body: null,
    pathParameters: { handle: 'testuser' },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    // Collection read defaults to empty; individual tests override.
    mocks.mockReadAllPages.mockResolvedValue({ ok: true, rows: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('returns 404 for unknown handle', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(404);
  });

  it('returns 404 when sharing is private', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { user_id: 'user-1', username: 'testuser', saved_artists_public: false, location: null },
            error: null,
          })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(404);
  });

  it('returns 200 with saved artists when public', async () => {
    // First call: usernames lookup
    // Second call: saved_artists lookup
    const maybeSingle = vi.fn(() => Promise.resolve({
      data: { user_id: 'user-1', username: 'testuser', saved_artists_public: true, location: 'Brooklyn, NY' },
      error: null,
    }));
    const savedSelect = vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({
          data: [
            {
              artist_slug: 'band-1',
              artist_name: 'Band One',
              artist_image_url: 'https://example.com/img.jpg',
              supported: true,
              artists: { slug: 'band-1', name: 'Band One', image_url: 'https://example.com/img.jpg' },
            },
            {
              artist_slug: 'band-2',
              artist_name: 'Band Two',
              artist_image_url: null,
              supported: false,
              artists: null,
            },
          ],
          error: null,
        })),
      })),
    }));

    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle,
        })),
      })),
    }).mockReturnValueOnce({
      select: savedSelect,
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.owner_display_name).toBe('testuser');
    expect(body.owner_location).toBe('Brooklyn, NY');
    expect(body.saved_artists).toHaveLength(2);
    expect(body.saved_artists[0].slug).toBe('band-1');
    expect(body.saved_artists[0].supported).toBe(true);
    expect(body.saved_artists[1].slug).toBe('band-2');
    expect(body.saved_artists[1].supported).toBe(false);
    // Must not include email or user_id
    expect(body.user_id).toBeUndefined();
    expect(body.email).toBeUndefined();
    expect(body.saved_artists[0].user_id).toBeUndefined();
  });

  describe('public collection (Support Loop Step 3)', () => {
    // usernames lookup + empty saved_artists; collection comes from mockReadAllPages.
    function setupPublicUser() {
      mocks.mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({
              data: { user_id: 'user-1', username: 'testuser', saved_artists_public: true, location: null },
              error: null,
            })),
          })),
        })),
      }).mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      });
    }

    it('includes purchased items, linking matched ones to their release page', async () => {
      setupPublicUser();
      mocks.mockReadAllPages.mockResolvedValue({
        ok: true,
        rows: [
          {
            title: 'Illinois',
            artist_name: 'Sufjan Stevens',
            art_url: null,
            acquired_at: '2026-01-01T00:00:00Z',
            releases: { slug: 'illinois', artwork_url: 'https://f4.bcbits.com/a.jpg', artists: { slug: 'sufjan-stevens' } },
          },
          {
            title: 'Obscure Tape',
            artist_name: 'Nobody We Know',
            art_url: null,
            acquired_at: null,
            releases: null,
          },
        ],
      });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(200);
      const body = JSON.parse(res!.body);
      expect(body.collection).toHaveLength(2);
      // Matched: release-page link and artwork fallback from the joined release.
      expect(body.collection[0]).toEqual({
        title: 'Illinois',
        artist_name: 'Sufjan Stevens',
        art_url: 'https://f4.bcbits.com/a.jpg',
        acquired_at: '2026-01-01T00:00:00Z',
        url: '/a/sufjan-stevens/illinois',
      });
      // Unmatched items still appear — they just don't link anywhere.
      expect(body.collection[1].url).toBeNull();
      expect(body.collection[1].title).toBe('Obscure Tape');
    });

    it('never exposes account metadata alongside the collection', async () => {
      setupPublicUser();
      mocks.mockReadAllPages.mockResolvedValue({
        ok: true,
        rows: [{ title: 'X', artist_name: 'Y', art_url: null, acquired_at: null, releases: null }],
      });
      const res = await handler(validEvent);
      expect(res!.body).not.toContain('user-1');
      expect(res!.body).not.toContain('user_id');
    });

    it('reports a failed collection read as an error, not an empty collection', async () => {
      setupPublicUser();
      mocks.mockReadAllPages.mockResolvedValue({ ok: false, reason: 'boom' });
      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(500);
    });
  });

  it('returns 200 with empty array when user has no saved artists', async () => {
    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({
            data: { user_id: 'user-1', username: 'testuser', saved_artists_public: true, location: null },
            error: null,
          })),
        })),
      })),
    }).mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.saved_artists).toEqual([]);
  });

  it('returns 400 when no handle provided', async () => {
    const res = await handler({
      ...validEvent,
      pathParameters: {},
    });
    expect(res!.statusCode).toBe(400);
  });

  it('returns 405-equivalent (404) for non-GET methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'POST' });
    expect(res!.statusCode).toBe(404);
  });
});