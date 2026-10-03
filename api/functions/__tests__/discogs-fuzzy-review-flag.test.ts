// A Discogs master whose title is close to a release we already hold must be flagged for review,
// whatever release type each source filed it under.
//
// Discogs' artist listing carries no type for a master, so 92% of Discogs rows are typed 'other'
// while the same record arrives from Bandcamp as 'album'. Tier 3 used to look only at stored rows
// of the incoming release's own type — a leftover of the old `(release_type, match_key)` keying —
// so a Discogs near-match against a Bandcamp album was never put in front of a human: it went
// onto the artist page as a second card. Release type is not identity, at any tier.

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
const BANDCAMP_ROW = 'releases-bandcamp';

/** The album as Bandcamp catalogued it: typed 'album', dated to the day. */
function seedBandcampAlbum(releaseType = 'album') {
  releases.push({
    id: BANDCAMP_ROW,
    artist_id: ARTIST,
    slug: 'blonde',
    title: 'Blonde',
    match_key: 'blonde',
    release_type: releaseType,
    release_date: '2016-08-20',
    date_precision: 'day',
    curated_fields: [],
    discogs_master_id: null,
  });
  sources.push({
    id: 'src-bandcamp',
    release_id: BANDCAMP_ROW,
    platform: 'bandcamp',
    url: 'https://example.bandcamp.com/album/blonde',
    external_id: '123',
    source: 'auto',
    detail_checked_at: null,
  });
}

/** A Discogs master as the artist listing delivers it: no type, so 'other', and a bare year. */
function discogsMaster(title: string, releaseDate: string) {
  return [{
    title,
    slug: title.toLowerCase().replace(/\W+/g, '-'),
    matchKey: title.toLowerCase().replace(/\W/g, ''),
    releaseType: 'other',
    releaseDate,
    datePrecision: 'year',
    status: 'released',
    masterId: 'master-1',
    mainReleaseId: 'main-1',
  }];
}

function insertedRelease(): Row | undefined {
  return inserted.find(i => i.table === 'releases')?.row;
}

beforeEach(() => {
  releases.length = 0;
  sources.length = 0;
  inserted.length = 0;
  updated.length = 0;
});

describe('persistDiscogsReleases — tier 3 across release types', () => {
  it("flags a Discogs 'other' near-match against a stored Bandcamp 'album', on both sides", async () => {
    seedBandcampAlbum();

    await persistDiscogsReleases(ARTIST, discogsMaster('Blonde (Deluxe)', '2016-01-01'));

    // Never a merge: the Discogs master gets its own row...
    expect(insertedRelease()?.title).toBe('Blonde (Deluxe)');
    // ...pointing at the Bandcamp album it resembles...
    expect(insertedRelease()?.needs_review).toBe(true);
    expect(insertedRelease()?.flagged_against_release_id).toBe(BANDCAMP_ROW);
    // ...and the Bandcamp album pointing back, so the pair shows up in /admin/release-review.
    const bandcamp = releases.find(r => r.id === BANDCAMP_ROW);
    expect(bandcamp?.needs_review).toBe(true);
    expect(bandcamp?.flagged_against_release_id).toBe(insertedRelease()?.id);
  });

  it('still flags a near-match of the same type (the case that already worked)', async () => {
    seedBandcampAlbum('other');

    await persistDiscogsReleases(ARTIST, discogsMaster('Blonde (Deluxe)', '2016-01-01'));

    expect(insertedRelease()?.flagged_against_release_id).toBe(BANDCAMP_ROW);
  });

  it('still lets a date disagreement veto the flag across types', async () => {
    // The guard that keeps the review queue usable applies to the wider pool too: a different
    // year is evidence of a different record, so no human is asked.
    seedBandcampAlbum();

    await persistDiscogsReleases(ARTIST, discogsMaster('Blonde (Deluxe)', '2019-01-01'));

    expect(insertedRelease()?.needs_review).toBeUndefined();
    expect(releases.find(r => r.id === BANDCAMP_ROW)?.needs_review).toBeUndefined();
  });
});
