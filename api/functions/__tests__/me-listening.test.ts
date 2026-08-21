import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  mockResolveArtistPages: vi.fn((_names: string[]) => Promise.resolve(new Map<string, string>())),
}));

// The gap's artist links are an enhancement layered on top of the computed list, and
// collection-utils resolves them with its own reads. Mocked so the gap logic is what's tested.
vi.mock('../collection-utils', () => ({ resolveArtistPages: mocks.mockResolveArtistPages }));

// getClient is mocked; readAllPages stays real so the paged read of existing
// signals is exercised, not stubbed (same pattern as bandcamp-sync.test.ts).
vi.mock('../db', async importOriginal => {
  const original = await importOriginal<typeof import('../db')>();
  return { ...original, getClient: () => ({ from: mocks.mockFrom }) };
});

/** An Authorization header whose token does not verify — see the ratelimit mock below. */
const REJECTED_TOKEN = 'Bearer rejected-token';

vi.mock('../ratelimit', () => ({
  // Mirrors the real helper: deriving the bucket verifies the token. A missing header and
  // the REJECTED_TOKEN sentinel both resolve to null — the second is how a test says
  // "header present, signature bad", the case an auth regression would actually hide.
  resolveAccountRequest: async (authHeader?: string) =>
    authHeader && authHeader !== REJECTED_TOKEN
      ? { key: 'user:user-1', user: { userId: 'user-1', email: 'test@example.com' } }
      : { key: 'ip:127.0.0.1', user: null },
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-listening';

/**
 * Wire mockFrom to a listening_signals table holding `existing` rows for the select path,
 * and return the upsert/delete spies for assertions. The select chain matches what the
 * handler builds through readAllPages: select → eq → eq → order → range.
 */
function mockTable(existing: Array<{ artist_name: string; play_count: number }>) {
  const upsert = vi.fn(
    (_rows: Array<Record<string, unknown>>, _opts: { onConflict: string }) =>
      Promise.resolve<{ error: { message: string } | null }>({ error: null })
  );
  const deleteEqSource = vi.fn(() => Promise.resolve({ error: null }));
  const deleteEqUser = vi.fn(() => ({ eq: deleteEqSource }));
  const del = vi.fn(() => ({ eq: deleteEqUser }));

  mocks.mockFrom.mockImplementation(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            range: vi.fn((from: number, to: number) =>
              Promise.resolve({ data: existing.slice(from, to + 1), error: null })),
          })),
        })),
      })),
    })),
    upsert,
    delete: del,
  }));

  return { upsert, del, deleteEqUser, deleteEqSource };
}

function postEvent(body: unknown) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify(body),
  };
}

function getEvent() {
  return { httpMethod: 'GET', headers: { authorization: 'Bearer valid-token' }, body: null };
}

interface GapBuilder {
  eq: () => GapBuilder;
  order: () => GapBuilder;
  range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
}

interface GapTables {
  signals?: Array<{ artist_name: string; play_count: number; last_played?: string | null }>;
  saved?: Array<{ artist_slug?: string | null; artist_name?: string | null; supported: boolean }>;
  collection?: Array<{ artist_name: string }>;
  /** Make one table's read fail, to separate "nothing found" from "couldn't look". */
  failing?: string;
}

/**
 * Wire mockFrom for the GET path: each table answers its own rows through the eq/order/range
 * chain readAllPages drives. There is nothing to spy on — the gap is derived from these rows,
 * so the response body is the assertion.
 */
function mockGapTables({ signals = [], saved = [], collection = [], failing }: GapTables) {
  const rowsFor: Record<string, Record<string, unknown>[]> = {
    listening_signals: signals.map(row => ({ last_played: null, ...row })),
    saved_artists: saved.map(row => ({ artist_slug: null, artist_name: null, ...row })),
    collection_items: collection,
  };

  mocks.mockFrom.mockImplementation((table: string) => ({
    select: () => {
      const builder: GapBuilder = {
        eq: () => builder,
        order: () => builder,
        range: (from, to) =>
          Promise.resolve(
            failing === table
              ? { data: null, error: { message: 'connection reset' } }
              : { data: (rowsFor[table] ?? []).slice(from, to + 1), error: null }
          ),
      };
      return builder;
    },
  }));
}

/** The gap list, in rank order. */
async function gapNames(): Promise<string[]> {
  const res = await handler(getEvent());
  expect(res!.statusCode).toBe(200);
  return JSON.parse(res!.body).gap.map((row: { artistName: string }) => row.artistName);
}

describe('me-listening handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
  });

  it('returns 401 when the token was checked and rejected, not just absent', async () => {
    const res = await handler({ httpMethod: 'POST', headers: { authorization: REJECTED_TOKEN }, body: '{}' });
    expect(res!.statusCode).toBe(401);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
    expect(res!.statusCode).toBe(401);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ httpMethod: 'OPTIONS', headers: {}, body: null });
    expect(res!.statusCode).toBe(204);
  });

  it('returns 404 for other methods', async () => {
    mockTable([]);
    const res = await handler({ httpMethod: 'PUT', headers: { authorization: 'Bearer valid-token' }, body: null });
    expect(res!.statusCode).toBe(404);
  });

  it('POST rejects invalid JSON', async () => {
    mockTable([]);
    const res = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer valid-token' }, body: '{not json' });
    expect(res!.statusCode).toBe(400);
  });

  it('POST rejects a source other than apple_music', async () => {
    mockTable([]);
    const res = await handler(postEvent({ source: 'lastfm', signals: [] }));
    expect(res!.statusCode).toBe(400);
  });

  it('POST rejects non-array signals and malformed entries', async () => {
    mockTable([]);
    expect((await handler(postEvent({ source: 'apple_music', signals: 'nope' })))!.statusCode).toBe(400);
    expect((await handler(postEvent({ source: 'apple_music', signals: [{ artistName: 'A', playCount: 1.5 }] })))!.statusCode).toBe(400);
    expect((await handler(postEvent({ source: 'apple_music', signals: [{ artistName: 'A', playCount: -1 }] })))!.statusCode).toBe(400);
    expect((await handler(postEvent({ source: 'apple_music', signals: [{ artistName: 42, playCount: 1 }] })))!.statusCode).toBe(400);
  });

  it('POST upserts only new and changed rows, in one chunked upsert on the unique key', async () => {
    const { upsert } = mockTable([
      { artist_name: 'Unchanged Artist', play_count: 5 },
      { artist_name: 'Grew Artist', play_count: 3 },
    ]);

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [
        { artistName: 'Unchanged Artist', playCount: 5 },
        { artistName: 'Grew Artist', playCount: 4 },
        { artistName: 'New Artist', playCount: 1 },
      ],
    }));

    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ received: 3, written: 2, unchanged: 1 });

    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: 'user_id,source,artist_name' });
    expect(rows.map(r => r.artist_name).sort()).toEqual(['Grew Artist', 'New Artist']);
    expect(rows.every(r => r.user_id === 'user-1' && r.source === 'apple_music')).toBe(true);
    expect(rows.find(r => r.artist_name === 'Grew Artist')!.play_count).toBe(4);

    // Listening is not saving. An upload conscripting artists into the saved list is the
    // behaviour Brandon reversed on 2026-08-16, and it would flood release alerts.
    expect(mocks.mockFrom).not.toHaveBeenCalledWith('saved_artists');
  });

  it('POST with nothing changed writes zero rows', async () => {
    const { upsert } = mockTable([{ artist_name: 'A', play_count: 5 }]);

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [{ artistName: 'A', playCount: 5 }],
    }));

    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ received: 1, written: 0, unchanged: 1 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('POST chunks large imports at 500 rows per upsert', async () => {
    const { upsert } = mockTable([]);

    const signals = Array.from({ length: 1200 }, (_, i) => ({
      artistName: `Artist ${i}`,
      playCount: i + 1,
    }));
    const res = await handler(postEvent({ source: 'apple_music', signals }));

    expect(res!.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(3);
    const chunkSizes = upsert.mock.calls.map(call => call[0].length);
    expect(chunkSizes).toEqual([500, 500, 200]);
  });

  it('POST diffs against a library larger than one PostgREST page', async () => {
    // 1,000 is exactly PostgREST's silent per-response cap. Artist 1000 lives on page two:
    // if the read stopped at one page, it would look new and be rewritten unchanged.
    const existing = Array.from({ length: 1001 }, (_, i) => ({
      artist_name: `Artist ${i}`,
      play_count: 1,
    }));
    const { upsert } = mockTable(existing);

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [{ artistName: 'Artist 1000', playCount: 1 }],
    }));

    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ received: 1, written: 0, unchanged: 1 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('POST dedupes repeated artist names, keeping the highest count', async () => {
    const { upsert } = mockTable([]);

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [
        { artistName: 'Twice', playCount: 2 },
        { artistName: 'Twice', playCount: 7 },
      ],
    }));

    expect(res!.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    const rows = upsert.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].play_count).toBe(7);
  });

  it('POST skips entries with a blank artist name rather than failing the sync', async () => {
    const { upsert } = mockTable([]);

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [
        { artistName: '   ', playCount: 3 },
        { artistName: 'Real Artist', playCount: 1 },
      ],
    }));

    expect(res!.statusCode).toBe(200);
    const rows = upsert.mock.calls[0][0];
    expect(rows.map(r => r.artist_name)).toEqual(['Real Artist']);
  });

  it('POST surfaces an upsert failure as a 500, not a silent success', async () => {
    const { upsert } = mockTable([]);
    upsert.mockResolvedValueOnce({ error: { message: 'boom' } });

    const res = await handler(postEvent({
      source: 'apple_music',
      signals: [{ artistName: 'A', playCount: 1 }],
    }));
    expect(res!.statusCode).toBe(500);
  });

  it("DELETE removes the user's apple_music rows in one statement", async () => {
    const { del, deleteEqUser, deleteEqSource } = mockTable([]);

    const res = await handler({ httpMethod: 'DELETE', headers: { authorization: 'Bearer valid-token' }, body: null });

    expect(res!.statusCode).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
    expect(deleteEqUser).toHaveBeenCalledWith('user_id', 'user-1');
    expect(deleteEqSource).toHaveBeenCalledWith('source', 'apple_music');
  });

  // The gap report: artists you play and have never paid. Private by construction — derived
  // from one user's own rows, returned only to that authenticated user, never rendered publicly.
  describe('GET — the gap report', () => {
    it('requires authentication, and does not read anything before refusing', async () => {
      mockGapTables({ signals: [{ artist_name: 'Private', play_count: 9 }] });
      const res = await handler({ httpMethod: 'GET', headers: {}, body: null });
      expect(res!.statusCode).toBe(401);
      expect(mocks.mockFrom).not.toHaveBeenCalled();
    });

    it('refuses a token that was checked and rejected, not just absent', async () => {
      mockGapTables({ signals: [{ artist_name: 'Private', play_count: 9 }] });
      const res = await handler({ httpMethod: 'GET', headers: { authorization: REJECTED_TOKEN }, body: null });
      expect(res!.statusCode).toBe(401);
      expect(mocks.mockFrom).not.toHaveBeenCalled();
    });

    it('ranks unsupported artists by plays, and reports the signal total', async () => {
      mockGapTables({
        signals: [
          { artist_name: 'Occasional', play_count: 5 },
          { artist_name: 'Heavy Rotation', play_count: 50 },
        ],
      });

      const res = await handler(getEvent());
      const body = JSON.parse(res!.body);
      expect(body.gap.map((row: { artistName: string }) => row.artistName)).toEqual([
        'Heavy Rotation',
        'Occasional',
      ]);
      expect(body.totalArtists).toBe(2);
    });

    it('excludes an artist already marked supported', async () => {
      mockGapTables({
        signals: [{ artist_name: 'Already Backed', play_count: 90 }],
        saved: [{ artist_slug: 'already-backed', supported: true }],
      });
      expect(await gapNames()).toEqual([]);
    });

    it('keeps an artist who is saved but NOT supported — saving is not paying', async () => {
      mockGapTables({
        signals: [{ artist_name: 'Saved Only', play_count: 30 }],
        saved: [{ artist_slug: 'saved-only', supported: false }],
      });
      expect(await gapNames()).toEqual(['Saved Only']);
    });

    // A row saved from a search result is filed under a synthetic slug the canonical one never
    // equals. Matching on the stored slug alone would tell a fan to go support somebody they
    // already support — so the name is re-derived too, as savedArtistIdsForUser does.
    it('excludes a supported artist saved under a synthetic slug', async () => {
      mockGapTables({
        signals: [{ artist_name: 'Sufjan Stevens', play_count: 40 }],
        saved: [{ artist_slug: 'sufjanstevens', artist_name: 'Sufjan Stevens', supported: true }],
      });
      expect(await gapNames()).toEqual([]);
    });

    it('excludes an artist you own a record by', async () => {
      mockGapTables({
        signals: [{ artist_name: 'Sufjan Stevens', play_count: 80 }],
        collection: [{ artist_name: 'Sufjan Stevens' }],
      });
      expect(await gapNames()).toEqual([]);
    });

    it('matches the collection on the derived slug, not raw text', async () => {
      // "Sigur Rós" in the library and "sigur ros" in the collection are one artist.
      mockGapTables({
        signals: [{ artist_name: 'Sigur Rós', play_count: 80 }],
        collection: [{ artist_name: 'sigur ros' }],
      });
      expect(await gapNames()).toEqual([]);
    });

    it('merges the same artist arriving from two sources', async () => {
      mockGapTables({
        signals: [
          { artist_name: 'Mirah', play_count: 30, last_played: '2026-07-01T00:00:00Z' },
          { artist_name: 'Mirah', play_count: 20, last_played: '2026-08-01T00:00:00Z' },
        ],
      });

      const res = await handler(getEvent());
      const gap = JSON.parse(res!.body).gap;
      expect(gap).toHaveLength(1);
      expect(gap[0].playCount).toBe(50);
      expect(gap[0].lastPlayed).toBe('2026-08-01T00:00:00Z');
    });

    it('links artists that have a page and leaves the rest unlinked', async () => {
      mockGapTables({ signals: [{ artist_name: 'Mirah', play_count: 9 }, { artist_name: 'No Page', play_count: 8 }] });
      mocks.mockResolveArtistPages.mockResolvedValueOnce(new Map([['Mirah', 'mirah']]));

      const res = await handler(getEvent());
      const gap = JSON.parse(res!.body).gap;
      expect(gap.map((row: { artistUrl: string | null }) => row.artistUrl)).toEqual(['/a/mirah', null]);
    });

    it('caps the list at 100 rows rather than dumping the library', async () => {
      mockGapTables({
        signals: Array.from({ length: 150 }, (_, i) => ({ artist_name: `Artist ${i}`, play_count: i + 1 })),
      });

      const res = await handler(getEvent());
      const body = JSON.parse(res!.body);
      expect(body.gap).toHaveLength(100);
      // The busiest artists, not the first hundred read.
      expect(body.gap[0].artistName).toBe('Artist 149');
      expect(body.totalArtists).toBe(150);
    });

    it('reports a failed signals read as an error, not an empty gap', async () => {
      mockGapTables({ failing: 'listening_signals' });
      const res = await handler(getEvent());
      expect(res!.statusCode).toBe(500);
    });

    // The asymmetry is deliberate: without the signals there is no report, but without the
    // exclusions there is still a useful one — narrowed, not blanked.
    it('still reports the gap when the saved-artists read fails', async () => {
      mockGapTables({ signals: [{ artist_name: 'Mirah', play_count: 9 }], failing: 'saved_artists' });
      expect(await gapNames()).toEqual(['Mirah']);
    });

    it('still reports the gap when the collection read fails', async () => {
      mockGapTables({ signals: [{ artist_name: 'Mirah', play_count: 9 }], failing: 'collection_items' });
      expect(await gapNames()).toEqual(['Mirah']);
    });

  });

  it('DELETE surfaces a database failure', async () => {
    const upsert = vi.fn();
    mocks.mockFrom.mockImplementation(() => ({
      upsert,
      delete: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ error: { message: 'boom' } })),
        })),
      })),
    }));

    const res = await handler({ httpMethod: 'DELETE', headers: { authorization: 'Bearer valid-token' }, body: null });
    expect(res!.statusCode).toBe(500);
  });
});
