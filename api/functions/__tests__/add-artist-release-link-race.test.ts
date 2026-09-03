// addArtistReleaseLink (#504): the read-then-write it does has no way to see a row inserted by a
// concurrent call between its own read and its own write. Two calls for the same
// (release_id, platform) can both read zero rows and both attempt an insert; the database's own
// unique index — idx_release_sources_release_platform_external, which two id-less rows on one
// platform can never both satisfy — is what actually catches that, as a 23505 on whichever insert
// loses the race. The fix treats that specific conflict as "someone else just created this row"
// and falls back to updating it, rather than either duplicating the row or failing the request.
//
// Driven against a recording fake, same approach as merge-releases-sources.test.ts, so the real
// function body runs end to end.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Op {
  table: string;
  op: 'select' | 'insert' | 'update';
  patch?: Record<string, unknown>;
  id?: string;
}

const ops: Op[] = [];

const RELEASE = '11111111-1111-1111-1111-111111111111';
const ARTIST = 'artist-1';
const PLATFORM = 'discogs';

interface SourceRow { id: string; platform: string; external_id: string | null; url: string }

let sources: SourceRow[] = [];
let insertConflicts = false;
// Models a second concurrent caller also losing its own race on the retry read — the retry
// must not fabricate a row to update in that case.
let retryFindsNoRow = false;

function makeClient() {
  return {
    from(table: string) {
      if (table === 'releases') {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, _val: string) => ({
              in: (_col2: string, ids: string[]) => {
                ops.push({ table, op: 'select' });
                return Promise.resolve({ data: ids.map(id => ({ id })), error: null });
              },
            }),
          }),
        };
      }

      // release_sources
      return {
        select: (_cols: string) => {
          const chain = {
            eq: (_col: string, _val: string) => chain,
            is: (_col: string, _val: null) => {
              ops.push({ table, op: 'select' });
              const rows = retryFindsNoRow ? [] : sources.filter(s => s.external_id === null);
              return Promise.resolve({ data: rows, error: null });
            },
            // Thenable so `await chain` resolves without an explicit terminal call — mirrors the
            // real query builder, and lets the initial read (no `.is()`) and the retry read
            // (with `.is()`) share the same chain object. Resolves with a snapshot, not a live
            // reference to `sources` — otherwise a later `insert()` push would silently grow the
            // rows array this call already handed back, which is exactly the kind of aliasing
            // the real Postgres round trip doesn't have.
            then: (resolve: (v: { data: SourceRow[]; error: null }) => void) => {
              ops.push({ table, op: 'select' });
              resolve({ data: [...sources], error: null });
            },
          };
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          ops.push({ table, op: 'insert', patch: row });
          if (insertConflicts) {
            // The row that won the race lands here — invisible to the read this call already
            // did, visible to the retry read that follows the conflict.
            sources.push({ id: 'winner-row', platform: row.platform as string, external_id: null, url: 'https://existing.example/already-there' });
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_release_sources_release_platform_external"' } });
          }
          sources.push({ id: 'new-row', platform: row.platform as string, external_id: null, url: row.url as string });
          return Promise.resolve({ error: null });
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            ops.push({ table, op: 'update', patch, id });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { addArtistReleaseLink } = await import('../db');

beforeEach(() => {
  ops.length = 0;
  sources = [];
  insertConflicts = false;
  retryFindsNoRow = false;
});

describe('addArtistReleaseLink — concurrent insert race', () => {
  it('falls back to updating the winning row instead of failing or duplicating', async () => {
    insertConflicts = true;

    const result = await addArtistReleaseLink(ARTIST, RELEASE, PLATFORM, 'https://discogs.com/release/999');

    expect(result).toBe(true);
    // Never a second insert attempt after the conflict.
    expect(ops.filter(o => o.table === 'release_sources' && o.op === 'insert')).toHaveLength(1);
    // Resolved onto the row the other caller created, not a fabricated one.
    expect(ops.some(o => o.table === 'release_sources' && o.op === 'update' && o.id === 'winner-row' && o.patch?.url === 'https://discogs.com/release/999')).toBe(true);
    // Exactly one row exists afterwards — no duplicate.
    expect(sources).toHaveLength(1);
  });

  it('still inserts cleanly when there is no race', async () => {
    const result = await addArtistReleaseLink(ARTIST, RELEASE, PLATFORM, 'https://discogs.com/release/1');

    expect(result).toBe(true);
    expect(sources).toHaveLength(1);
    expect(ops.some(o => o.table === 'release_sources' && o.op === 'update')).toBe(false);
  });

  it('reports failure rather than guessing if the conflict retry cannot find exactly one row', async () => {
    insertConflicts = true;
    retryFindsNoRow = true;

    const result = await addArtistReleaseLink(ARTIST, RELEASE, PLATFORM, 'https://discogs.com/release/2');

    expect(result).toBe(false);
    expect(ops.some(o => o.table === 'release_sources' && o.op === 'update')).toBe(false);
  });
});
