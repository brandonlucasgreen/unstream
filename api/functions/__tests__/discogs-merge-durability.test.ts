// A Discogs master an admin merged away must not come back on the next catalogue pass.
//
// This is the property that decides whether the release review queue is a queue or a treadmill.
// `releases.discogs_master_id` holds exactly one id, and a merge keeps the survivor's — so the
// second master survives only as an `external_id` on the source row that was moved across. If
// ingest looked only at the release column, it would see a master with no row, insert one, flag
// the pair, and hand the admin back the same decision they just made. Forever.
//
// The second property is quieter and just as easy to lose: a merged-away master must not
// rewrite the survivor's title. The title on the surviving row is the one a human chose to
// keep, and "matched by hard identifier" is what normally licenses overwriting it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const releases: Row[] = [];
const sources: Row[] = [];
const inserted: { table: string; row: Row }[] = [];
const updated: { table: string; id: unknown; patch: Row }[] = [];

function tableOf(name: string): Row[] {
  return name === 'releases' ? releases : sources;
}

function makeClient() {
  return {
    from(table: string) {
      const rows = tableOf(table);
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(_c: string, _v: unknown) { return builder; },
        in() { return Promise.resolve({ data: rows, error: null }); },
        update(patch: Row) {
          return {
            eq: (_c: string, id: unknown) => {
              updated.push({ table, id, patch });
              const row = rows.find(r => r.id === id);
              if (row) Object.assign(row, patch);
              const p = Promise.resolve({ data: row ?? null, error: null }) as Record<string, unknown>;
              p.select = () => ({ single: () => Promise.resolve({ data: row ?? null, error: null }) });
              return p;
            },
          };
        },
        insert(row: Row) {
          const created = { id: `${table}-${rows.length + 1}`, detail_checked_at: null, ...row };
          rows.push(created);
          inserted.push({ table, row: created });
          return { select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }) };
        },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { persistDiscogsReleases } = await import('../db');

const ARTIST = 'artist-1';
const SURVIVOR = 'releases-survivor';

/** A release an admin merged out of two Discogs masters: one on the row, one on a source. */
function seedMergedRelease() {
  releases.push({
    id: SURVIVOR,
    artist_id: ARTIST,
    slug: 'blonde',
    title: 'Blonde',
    match_key: 'blonde',
    release_type: 'other',
    release_date: '2014-01-01',
    date_precision: 'year',
    curated_fields: [],
    discogs_master_id: 'master-keep',
  });
  sources.push(
    { id: 'src-1', release_id: SURVIVOR, platform: 'discogs', url: 'https://www.discogs.com/release/1', external_id: 'master-keep', source: 'auto', detail_checked_at: null },
    { id: 'src-2', release_id: SURVIVOR, platform: 'discogs', url: 'https://www.discogs.com/release/2', external_id: 'master-drop', source: 'auto', detail_checked_at: null },
  );
}

function master(id: string, title: string) {
  return [{
    title,
    slug: title.toLowerCase().replace(/\W+/g, '-'),
    matchKey: title.toLowerCase().replace(/\W/g, ''),
    releaseType: 'other',
    releaseDate: '2014-01-01',
    datePrecision: 'year',
    status: 'released',
    masterId: id,
    mainReleaseId: `main-${id}`,
  }];
}

beforeEach(() => {
  releases.length = 0;
  sources.length = 0;
  inserted.length = 0;
  updated.length = 0;
});

describe('persistDiscogsReleases — a merged-away master', () => {
  it('resolves to the surviving release instead of inserting a new one', async () => {
    seedMergedRelease();

    await persistDiscogsReleases(ARTIST, master('master-drop', 'Blonde'));

    expect(inserted.filter(i => i.table === 'releases')).toEqual([]);
    expect(releases).toHaveLength(1);
  });

  it('does not rewrite the survivor with the merged-away master\'s title', async () => {
    seedMergedRelease();

    // Discogs' second master for this record is titled differently — which is often why there
    // were two masters in the first place.
    await persistDiscogsReleases(ARTIST, master('master-drop', 'BLONDE (Deluxe)'));

    expect(releases[0].title).toBe('Blonde');
    expect(updated.some(u => u.table === 'releases' && u.patch.title !== undefined)).toBe(false);
  });

  it('still inserts a master nobody has seen before', async () => {
    seedMergedRelease();

    await persistDiscogsReleases(ARTIST, master('master-new', 'Endless'));

    expect(inserted.filter(i => i.table === 'releases')).toHaveLength(1);
    expect(inserted[0].row.discogs_master_id).toBe('master-new');
  });

  it('still takes the title from a master the release row itself carries', async () => {
    // The control for the second test: a hard-identifier match on `releases.discogs_master_id`
    // is exactly what does license a title rewrite, and that must keep working.
    seedMergedRelease();

    await persistDiscogsReleases(ARTIST, master('master-keep', 'Blonde (2014 Remaster)'));

    expect(releases[0].title).toBe('Blonde (2014 Remaster)');
  });
});
