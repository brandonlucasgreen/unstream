// addArtistReleaseLink used to refuse any edit once a release held 2+ sources on one platform
// (two Discogs masters an admin merged into one record). That refusal was meant for ingest
// sources with no way to tell them apart — but it also caught the artist's own `claimed` row,
// which is unambiguous by construction, and left them unable to fix a link on a merged release.
//
// Driven against a recording fake, same pattern as merge-releases-sources.test.ts, so the real
// function body runs rather than a mock of it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Op {
  table: string;
  op: 'select' | 'update' | 'insert';
  patch?: Record<string, unknown>;
  id?: string;
}

const ops: Op[] = [];

const ARTIST_ID = 'artist-1';
const RELEASE_ID = 'release-1';

interface SourceRow { id: string; source: string }

let sources: SourceRow[] = [];
let ownsRelease = true;

function makeClient() {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _value: string) {
              return {
                eq(_col2: string, _value2: string) {
                  ops.push({ table, op: 'select' });
                  if (table === 'releases') {
                    return Promise.resolve({ data: ownsRelease ? [{ id: RELEASE_ID }] : [], error: null });
                  }
                  return Promise.resolve({ data: sources, error: null });
                },
                in(_col2: string, _vals: string[]) {
                  ops.push({ table, op: 'select' });
                  return Promise.resolve({ data: ownsRelease ? [{ id: RELEASE_ID }] : [], error: null });
                },
              };
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
        insert(patch: Record<string, unknown>) {
          ops.push({ table, op: 'insert', patch });
          return Promise.resolve({ error: null });
        },
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
  ownsRelease = true;
});

describe('addArtistReleaseLink — multiple sources on one platform', () => {
  it('updates the existing claimed row when one already exists, ignoring extra ingest sources', async () => {
    sources = [
      { id: 'ingest-1', source: 'discogs' },
      { id: 'claimed-1', source: 'claimed' },
    ];

    const ok = await addArtistReleaseLink(ARTIST_ID, RELEASE_ID, 'discogs', 'https://discogs.com/mine');

    expect(ok).toBe(true);
    expect(ops).toContainEqual(
      expect.objectContaining({ table: 'release_sources', op: 'update', id: 'claimed-1' })
    );
  });

  it('refuses when there are 2+ ingest sources and no claimed row', async () => {
    sources = [
      { id: 'ingest-1', source: 'discogs' },
      { id: 'ingest-2', source: 'discogs' },
    ];

    const ok = await addArtistReleaseLink(ARTIST_ID, RELEASE_ID, 'discogs', 'https://discogs.com/mine');

    expect(ok).toBe(false);
    expect(ops.some((o) => o.op === 'update' || o.op === 'insert')).toBe(false);
  });

  it('updates the single existing source when there is exactly one, as before', async () => {
    sources = [{ id: 'ingest-1', source: 'discogs' }];

    const ok = await addArtistReleaseLink(ARTIST_ID, RELEASE_ID, 'discogs', 'https://discogs.com/mine');

    expect(ok).toBe(true);
    expect(ops).toContainEqual(
      expect.objectContaining({ table: 'release_sources', op: 'update', id: 'ingest-1' })
    );
  });

  it('inserts a new claimed source when none exist yet', async () => {
    sources = [];

    const ok = await addArtistReleaseLink(ARTIST_ID, RELEASE_ID, 'discogs', 'https://discogs.com/mine');

    expect(ok).toBe(true);
    expect(ops).toContainEqual(
      expect.objectContaining({ table: 'release_sources', op: 'insert' })
    );
  });
});
