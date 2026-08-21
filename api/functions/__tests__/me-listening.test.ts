import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
}));

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
    const res = await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer valid-token' }, body: null });
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
