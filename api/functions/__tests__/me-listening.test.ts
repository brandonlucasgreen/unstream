import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadAllPages: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
}));

// Real artistSlug: the gap decides who counts as "already supported" by comparing derived
// slugs, so a stub here would let the test pass while the comparison drifted from the key
// every writer actually uses.
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
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../collection-utils', () => ({ resolveArtistPages: () => Promise.resolve(new Map()) }));

import { handler, parseSignals } from '../me-listening';

function authed(method: string, body: unknown = null) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer valid-token' },
    body: body === null ? null : JSON.stringify(body),
  };
}

/** readAllPages is called for listening_signals, then saved_artists, then collection_items. */
function stubReads(signals: unknown[], saved: unknown[], collection: unknown[]) {
  mocks.mockReadAllPages
    .mockResolvedValueOnce({ ok: true, rows: signals })
    .mockResolvedValueOnce({ ok: true, rows: saved })
    .mockResolvedValueOnce({ ok: true, rows: collection });
}

describe('parseSignals', () => {
  it('drops unusable entries and clamps counts', () => {
    const out = parseSignals([
      { artistName: '  Mirah  ', playCount: 12 },
      { artistName: '', playCount: 5 },
      { artistName: 'No Count' },
      { artistName: 'Negative', playCount: -4 },
      'junk',
      null,
    ]);
    expect(out).toEqual([
      { artistName: 'Mirah', playCount: 12, lastPlayed: null },
      { artistName: 'No Count', playCount: 0, lastPlayed: null },
      { artistName: 'Negative', playCount: 0, lastPlayed: null },
    ]);
  });

  it('collapses a repeated artist, keeping the larger count', () => {
    // A duplicate inside one upsert batch is a Postgres error, not a harmless overwrite.
    const out = parseSignals([
      { artistName: 'Mirah', playCount: 3 },
      { artistName: 'mirah', playCount: 9 },
    ]);
    expect(out).toEqual([{ artistName: 'Mirah', playCount: 9, lastPlayed: null }]);
  });

  it('refuses a non-array or an implausibly large batch', () => {
    expect(parseSignals({})).toBeNull();
    expect(parseSignals(Array.from({ length: 10_001 }, () => ({ artistName: 'x', playCount: 1 })))).toBeNull();
  });
});

describe('me-listening handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }) },
    });
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null });
    expect(res!.statusCode).toBe(401);
  });

  it('rejects an unknown source', async () => {
    const res = await handler(authed('POST', { source: 'spotify', signals: [] }));
    expect(res!.statusCode).toBe(400);
  });

  it('stores uploaded signals and never touches saved_artists', async () => {
    const upsert = vi.fn((..._a: unknown[]) => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({ upsert });

    const res = await handler(
      authed('POST', {
        source: 'apple_music',
        signals: [{ artistName: 'Mirah', playCount: 47, lastPlayed: '2026-08-01T00:00:00Z' }],
      })
    );

    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).stored).toBe(1);
    expect(mocks.mockFrom).toHaveBeenCalledWith('listening_signals');
    // Listening is not saving — the whole point of the 2026-08-16 reversal.
    expect(mocks.mockFrom).not.toHaveBeenCalledWith('saved_artists');
    expect(upsert.mock.calls[0][0]).toEqual([
      expect.objectContaining({ user_id: 'user-1', source: 'apple_music', artist_name: 'Mirah', play_count: 47 }),
    ]);
  });

  describe('GET — the gap', () => {
    it('ranks unsupported artists by plays', async () => {
      stubReads(
        [
          { artist_name: 'Heavy Rotation', play_count: 50, last_played: null },
          { artist_name: 'Occasional', play_count: 5, last_played: null },
        ],
        [],
        []
      );
      const res = await handler(authed('GET'));
      const body = JSON.parse(res!.body);
      expect(body.gap.map((g: { artistName: string }) => g.artistName)).toEqual([
        'Heavy Rotation',
        'Occasional',
      ]);
    });

    it('excludes artists already marked supported', async () => {
      stubReads(
        [{ artist_name: 'Already Backed', play_count: 90, last_played: null }],
        [{ artist_slug: 'already-backed', supported: true }],
        []
      );
      const res = await handler(authed('GET'));
      expect(JSON.parse(res!.body).gap).toEqual([]);
    });

    it('keeps an artist who is saved but NOT supported — saving is not paying', async () => {
      stubReads(
        [{ artist_name: 'Saved Only', play_count: 30, last_played: null }],
        [{ artist_slug: 'saved-only', supported: false }],
        []
      );
      const res = await handler(authed('GET'));
      expect(JSON.parse(res!.body).gap.map((g: { artistName: string }) => g.artistName)).toEqual(['Saved Only']);
    });

    it('excludes artists you own a record by', async () => {
      stubReads(
        [{ artist_name: 'Sufjan Stevens', play_count: 80, last_played: null }],
        [],
        [{ artist_name: 'Sufjan Stevens' }]
      );
      const res = await handler(authed('GET'));
      expect(JSON.parse(res!.body).gap).toEqual([]);
    });

    it('matches the collection on the derived slug, not raw text', async () => {
      // "Sigur Rós" in the library vs "sigur ros" in the collection is one artist.
      stubReads(
        [{ artist_name: 'Sigur Rós', play_count: 80, last_played: null }],
        [],
        [{ artist_name: 'sigur ros' }]
      );
      const res = await handler(authed('GET'));
      expect(JSON.parse(res!.body).gap).toEqual([]);
    });

    it('merges the same artist arriving from two sources', async () => {
      stubReads(
        [
          { artist_name: 'Mirah', play_count: 30, last_played: '2026-07-01T00:00:00Z' },
          { artist_name: 'Mirah', play_count: 20, last_played: '2026-08-01T00:00:00Z' },
        ],
        [],
        []
      );
      const res = await handler(authed('GET'));
      const gap = JSON.parse(res!.body).gap;
      expect(gap).toHaveLength(1);
      expect(gap[0].playCount).toBe(50);
      expect(gap[0].lastPlayed).toBe('2026-08-01T00:00:00Z');
    });

    it('reports a failed read as an error, not an empty gap', async () => {
      mocks.mockReadAllPages.mockResolvedValueOnce({ ok: false, reason: 'boom' });
      const res = await handler(authed('GET'));
      expect(res!.statusCode).toBe(500);
    });
  });

  it('DELETE removes the uploaded signals', async () => {
    const eq = vi.fn(() => Promise.resolve({ error: null }));
    mocks.mockFrom.mockReturnValue({ delete: vi.fn(() => ({ eq })) });
    const res = await handler(authed('DELETE'));
    expect(res!.statusCode).toBe(200);
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
  });
});
