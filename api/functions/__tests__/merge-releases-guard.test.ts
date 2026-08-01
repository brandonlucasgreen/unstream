// The same-artist guard on mergeReleases.
//
// A merge is close to irreversible — `release_sources` rows are moved onto the survivor and the
// other release row is deleted. The artist-facing endpoint proves ownership of both ids before
// calling; the admin endpoint passes ids straight from a request body. So the invariant has to
// hold inside `mergeReleases` itself, and the property worth locking is not just "it returns an
// error" but that **nothing was written before it decided** — a guard that refuses after moving
// the sources would be worse than no guard at all.
//
// Driven against a recording fake Supabase client rather than the module mock every endpoint
// test uses, because the whole point is to exercise the real function body.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Op {
  table: string;
  op: 'select' | 'update' | 'delete';
}

const ops: Op[] = [];

/** Rows `releases.select('id, artist_id').in(...)` will return. Set per test. */
let pairRows: { id: string; artist_id: string }[] = [];

function makeClient() {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          const record = () => ops.push({ table, op: 'select' });
          return {
            // releases: .select('id, artist_id').in('id', [...])
            in: (_col: string, _vals: string[]) => {
              record();
              return Promise.resolve({ data: pairRows, error: null });
            },
            // release_sources: .select(...).eq('release_id', x)
            eq: (_col: string, _val: string) => {
              record();
              const p = Promise.resolve({ data: [], error: null }) as Promise<{ data: unknown; error: null }> & {
                maybeSingle?: () => Promise<{ data: unknown; error: null }>;
              };
              p.maybeSingle = () => Promise.resolve({ data: null, error: null });
              return p;
            },
          };
        },
        update(_patch: Record<string, unknown>) {
          return {
            eq: (_col: string, _val: string) => {
              ops.push({ table, op: 'update' });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            eq: (_col: string, _val: string) => {
              ops.push({ table, op: 'delete' });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { mergeReleases } = await import('../db');

const KEEP = '11111111-1111-1111-1111-111111111111';
const DROP = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  ops.length = 0;
});

describe('mergeReleases — same-artist guard', () => {
  it('refuses a pair belonging to two different artists', async () => {
    pairRows = [
      { id: KEEP, artist_id: 'artist-a' },
      { id: DROP, artist_id: 'artist-b' },
    ];

    const result = await mergeReleases(KEEP, DROP);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/different artists/i);
  });

  // The property that actually matters: refusing late would already have moved the sources.
  it('writes nothing at all when it refuses a cross-artist pair', async () => {
    pairRows = [
      { id: KEEP, artist_id: 'artist-a' },
      { id: DROP, artist_id: 'artist-b' },
    ];

    await mergeReleases(KEEP, DROP);

    expect(ops.filter(o => o.op === 'update')).toEqual([]);
    expect(ops.filter(o => o.op === 'delete')).toEqual([]);
  });

  it('refuses when either release cannot be found, rather than merging into a gap', async () => {
    pairRows = [{ id: KEEP, artist_id: 'artist-a' }]; // dropId missing

    const result = await mergeReleases(KEEP, DROP);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be found/i);
    expect(ops.some(o => o.op === 'delete')).toBe(false);
  });

  it('refuses merging a release into itself', async () => {
    const result = await mergeReleases(KEEP, KEEP);
    expect(result.ok).toBe(false);
    // Refused before touching the database at all.
    expect(ops).toEqual([]);
  });

  it('proceeds to the source-conflict check for a same-artist pair', async () => {
    pairRows = [
      { id: KEEP, artist_id: 'artist-a' },
      { id: DROP, artist_id: 'artist-a' },
    ];

    const result = await mergeReleases(KEEP, DROP);

    // The fake returns no sources and no rows to backfill from, so this reaches the delete —
    // which is the point: a same-artist pair is *not* blocked by the new guard.
    expect(result.ok).toBe(true);
    expect(ops.some(o => o.table === 'releases' && o.op === 'delete')).toBe(true);
  });
});
