// What mergeReleases does when both releases carry a source on the same platform.
//
// This used to be a flat refusal, and it was the single reason the release review queue could
// not be cleared: sampled 2026-08-29, 59 duplicate pairs in the catalog had a Discogs source on
// both sides, because Discogs routinely files two masters for one record ("Blonde" twice in
// 2014, "Petal" twice on 2026-07-31). Every one of those was unmergeable.
//
// The rule now turns on whether the two sources can be *told apart*. Two Discogs masters carry
// two ids and merge fine; a source with no external id on either side is indistinguishable from
// the one it would sit beside, and the unique index would reject it anyway.
//
// Driven against a recording fake rather than the module mock, for the same reason as
// merge-releases-guard.test.ts: the point is to run the real function body.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Op {
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete';
  patch?: Record<string, unknown>;
  id?: string;
}

const ops: Op[] = [];

const KEEP = '11111111-1111-1111-1111-111111111111';
const DROP = '22222222-2222-2222-2222-222222222222';

interface SourceRow { id: string; platform: string; external_id: string | null }

let sourcesByRelease: Record<string, SourceRow[]> = {};

/** What the survivor's own row already claims, which decides whether an anchor is copied. */
let keepMasterId: string | null = 'master-keep';

function makeClient() {
  return {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            in: (_col: string, _vals: string[]) => {
              ops.push({ table, op: 'select' });
              return Promise.resolve({
                data: [
                  { id: KEEP, artist_id: 'artist-a' },
                  { id: DROP, artist_id: 'artist-a' },
                ],
                error: null,
              });
            },
            eq: (_col: string, value: string) => {
              ops.push({ table, op: 'select', id: value });
              const data = table === 'release_sources' ? sourcesByRelease[value] ?? [] : [];
              const p = Promise.resolve({ data, error: null }) as Promise<{ data: unknown; error: null }> & {
                maybeSingle?: () => Promise<{ data: unknown; error: null }>;
              };
              // The release row read that backfills date / artwork / identity anchors.
              p.maybeSingle = () =>
                Promise.resolve({
                  data: cols.includes('curated_fields')
                    ? { release_date: null, artwork_url: null, curated_fields: [], discogs_master_id: keepMasterId, musicbrainz_release_group_id: null }
                    : { release_date: '2014-01-01', date_precision: 'year', artwork_url: null, discogs_master_id: 'master-drop', musicbrainz_release_group_id: null },
                  error: null,
                });
              return p;
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (_col: string, value: string) => {
              ops.push({ table, op: 'update', patch, id: value });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            eq: (_col: string, value: string) => {
              ops.push({ table, op: 'delete', id: value });
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

beforeEach(() => {
  ops.length = 0;
  sourcesByRelease = {};
  keepMasterId = 'master-keep';
});

describe('mergeReleases — two sources on one platform', () => {
  it('merges two Discogs masters, moving the second onto the survivor', async () => {
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'discogs', external_id: 'master-keep' }],
      [DROP]: [{ id: 's2', platform: 'discogs', external_id: 'master-drop' }],
    };

    const result = await mergeReleases(KEEP, DROP);

    expect(result.ok).toBe(true);
    expect(ops.some(o => o.table === 'release_sources' && o.op === 'update' && o.id === DROP)).toBe(true);
    expect(ops.some(o => o.table === 'releases' && o.op === 'delete' && o.id === DROP)).toBe(true);
  });

  it('carries the dropped master id onto the survivor only after the delete', async () => {
    // `idx_releases_discogs_master` is unique per artist, so writing the dropped id onto the
    // survivor while the row it came from still holds it is a constraint violation, not a merge.
    keepMasterId = null;
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'bandcamp', external_id: 'album-1' }],
      [DROP]: [{ id: 's2', platform: 'discogs', external_id: 'master-drop' }],
    };

    await mergeReleases(KEEP, DROP);

    const anchorWrite = ops.findIndex(
      o => o.table === 'releases' && o.op === 'update' && o.patch?.discogs_master_id === 'master-drop'
    );
    const deleteAt = ops.findIndex(o => o.table === 'releases' && o.op === 'delete');

    expect(anchorWrite).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(anchorWrite).toBeGreaterThan(deleteAt);
  });

  it('leaves an identity anchor alone when the survivor already has one', async () => {
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'discogs', external_id: 'master-keep' }],
      [DROP]: [{ id: 's2', platform: 'discogs', external_id: 'master-drop' }],
    };

    await mergeReleases(KEEP, DROP);

    // The survivor's own master id stands; the dropped one survives on the moved source row,
    // which is where persistDiscogsReleases also looks.
    expect(ops.some(o => o.op === 'update' && o.patch?.discogs_master_id !== undefined)).toBe(false);
  });

  it('refuses when a shared platform has no id on the dropped side', async () => {
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'discogs', external_id: 'master-keep' }],
      [DROP]: [{ id: 's2', platform: 'discogs', external_id: null }],
    };

    const result = await mergeReleases(KEEP, DROP);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unidentified source on: discogs/i);
    expect(ops.some(o => o.op === 'update' || o.op === 'delete')).toBe(false);
  });

  it('refuses when a shared platform has no id on the surviving side either', async () => {
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'bandcamp', external_id: null }],
      [DROP]: [{ id: 's2', platform: 'bandcamp', external_id: 'album-2' }],
    };

    const result = await mergeReleases(KEEP, DROP);

    expect(result.ok).toBe(false);
    expect(ops.some(o => o.op === 'update' || o.op === 'delete')).toBe(false);
  });

  it('still merges cleanly when the platforms do not overlap at all', async () => {
    sourcesByRelease = {
      [KEEP]: [{ id: 's1', platform: 'bandcamp', external_id: 'album-1' }],
      [DROP]: [{ id: 's2', platform: 'discogs', external_id: 'master-drop' }],
    };

    const result = await mergeReleases(KEEP, DROP);
    expect(result.ok).toBe(true);
  });
});
