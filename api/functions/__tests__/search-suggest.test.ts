import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockSuggestArtists: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  // Pass-through cache: always calls the fetcher, records the shouldCache verdict.
  mockCacheGetOrFetch: vi.fn(),
  lastShouldCache: { value: null as boolean | null },
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    suggestArtists: mocks.mockSuggestArtists,
  };
});
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../cache', () => ({
  cacheGetOrFetch: mocks.mockCacheGetOrFetch,
}));

import { handler } from '../search-suggest';
import { rankArtistSuggestions } from '../db';

beforeEach(() => {
  mocks.mockSuggestArtists.mockReset();
  mocks.lastShouldCache.value = null;
  mocks.mockCacheGetOrFetch.mockImplementation(
    async (_key: string, fetchFn: () => Promise<unknown>, _ttl: number, shouldCache?: (d: unknown) => boolean) => {
      const data = await fetchFn();
      mocks.lastShouldCache.value = shouldCache ? shouldCache(data) : true;
      return { data, cached: false };
    },
  );
});

describe('search-suggest handler', () => {
  it('returns suggestions for a valid query', async () => {
    mocks.mockSuggestArtists.mockResolvedValue([
      { slug: 'the-argent-grub', name: 'The Argent Grub', imageUrl: null },
    ]);
    const res = await handler({ queryStringParameters: { query: 'argent' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].name).toBe('The Argent Grub');
  });

  it('returns an empty 200 for sub-2-character queries without hitting the DB', async () => {
    const res = await handler({ queryStringParameters: { query: 'a' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).suggestions).toEqual([]);
    expect(mocks.mockSuggestArtists).not.toHaveBeenCalled();
  });

  it('rejects a missing query', async () => {
    const res = await handler({ queryStringParameters: {} });
    expect(res.statusCode).toBe(400);
  });

  it('does not cache a DB failure as "no suggestions"', async () => {
    mocks.mockSuggestArtists.mockResolvedValue(null);
    const res = await handler({ queryStringParameters: { query: 'argent' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).suggestions).toEqual([]);
    expect(mocks.lastShouldCache.value).toBe(false);
  });

  it('does cache a genuine empty answer', async () => {
    mocks.mockSuggestArtists.mockResolvedValue([]);
    await handler({ queryStringParameters: { query: 'zzzznobody' } });
    expect(mocks.lastShouldCache.value).toBe(true);
  });
});

describe('rankArtistSuggestions', () => {
  const rows = [
    { slug: 'goodnight-argent', name: 'Goodnight Argent', image_url: null },
    { slug: 'argent', name: 'Argent', image_url: 'https://img/argent.jpg' },
    { slug: 'the-argent-grub', name: 'The Argent Grub', image_url: null },
    { slug: 'argentheart', name: 'ArgentHeart', image_url: null },
  ];

  it('puts prefix matches first, shorter names before longer', () => {
    const ranked = rankArtistSuggestions(rows, 'argent', 8);
    expect(ranked.map(r => r.name)).toEqual([
      'Argent', 'ArgentHeart', 'The Argent Grub', 'Goodnight Argent',
    ]);
  });

  it('respects the limit and dedupes by slug', () => {
    const dupes = [...rows, { slug: 'argent', name: 'Argent', image_url: null }];
    const ranked = rankArtistSuggestions(dupes, 'argent', 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toEqual({ slug: 'argent', name: 'Argent', imageUrl: 'https://img/argent.jpg' });
  });

  it('drops rows with missing fields', () => {
    const ranked = rankArtistSuggestions(
      [{ slug: '', name: 'X', image_url: null }, { slug: 'ok', name: 'Argent', image_url: null }],
      'argent',
      8,
    );
    expect(ranked.map(r => r.slug)).toEqual(['ok']);
  });
});
