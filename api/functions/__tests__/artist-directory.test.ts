import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(() => ({ from: mocks.mockFrom })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.mockCreateClient,
}));

import { handler } from '../artist-directory';

describe('artist-directory handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockCreateClient.mockReturnValue({ from: mocks.mockFrom });
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
  });

  it('scope=known lists verified (unclaimed) artists, sorted by name, with no join', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn((column: string, value: string) => {
          expect(column).toBe('match_confidence');
          expect(value).toBe('verified');
          return Promise.resolve({
            data: [
              { slug: 'zzz-artist', name: 'ZZZ Artist', image_url: null },
              { slug: 'patrick-hardy', name: 'Patrick Hardy', image_url: 'https://img/p.jpg' },
            ],
            error: null,
          });
        }),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'known' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.artists).toEqual([
      { slug: 'patrick-hardy', name: 'Patrick Hardy', imageUrl: 'https://img/p.jpg' },
      { slug: 'zzz-artist', name: 'ZZZ Artist', imageUrl: null },
    ]);
    // Only one query — no artist_profiles join for the known scope.
    expect(mocks.mockFrom).toHaveBeenCalledTimes(1);
    expect(mocks.mockFrom).toHaveBeenCalledWith('artists');
  });

  it('scope=known returns 500 on a query error', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'known' } });
    expect(res.statusCode).toBe(500);
  });

  it('default scope lists claimed (verified profile) artists via the artist_profiles join', async () => {
    mocks.mockFrom
      .mockReturnValueOnce({
        select: vi.fn(() => ({
          not: vi.fn(() => Promise.resolve({
            data: [{ artist_id: 'a1', custom_image_url: null }],
            error: null,
          })),
        })),
      })
      .mockReturnValueOnce({
        select: vi.fn(() => ({
          in: vi.fn(() => Promise.resolve({
            data: [{ id: 'a1', name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', image_url: 'https://img/k.jpg' }],
            error: null,
          })),
        })),
      });

    const res = await handler({});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.artists).toEqual([
      { slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: 'https://img/k.jpg' },
    ]);
    expect(mocks.mockFrom).toHaveBeenCalledWith('artist_profiles');
    expect(mocks.mockFrom).toHaveBeenCalledWith('artists');
  });

  it('an unrecognized scope value falls back to the claimed (default) path', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        not: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    });

    const res = await handler({ queryStringParameters: { scope: 'bogus' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artists).toEqual([]);
    expect(mocks.mockFrom).toHaveBeenCalledWith('artist_profiles');
  });
});
