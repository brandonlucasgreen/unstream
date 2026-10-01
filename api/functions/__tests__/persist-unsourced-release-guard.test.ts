// No ingest path may leave a release with no sources behind.
//
// Every persist* function inserts the release row before its fallible source write. When the
// listing already belongs to another release — measured 2026-10-01, ~600 of 676 source-less rows
// were a *different artist's* release holding it: a Faircamp label site linked from several artist
// rows, two rows for one artist sharing a Bandcamp link, a Discogs master credited to two artists —
// the global UNIQUE (platform, external_id) rejects the source and the row used to stay, rendering
// on artist pages and feeds with nowhere to buy it. findReleaseBySource (#554) only looks within
// the artist, so it can't see these.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
const writes: { table: string; op: 'update' | 'insert' | 'delete'; patch: Row }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const rowsOf = () => (tables[table] ??= []);
      const matched = () => rowsOf().filter(r => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));

      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return builder; },
        in(c: string, vs: unknown[]) { ins.push([c, vs]); return builder; },
        update(patch: Row) {
          writes.push({ table, op: 'update', patch });
          return {
            eq: (_c: string, id: unknown) => {
              const row = rowsOf().find(r => r.id === id);
              if (row) Object.assign(row, patch);
              return {
                select: () => ({ single: () => Promise.resolve({ data: row ?? null, error: null }) }),
                then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve, reject),
              };
            },
          };
        },
        insert(patch: Row) {
          writes.push({ table, op: 'insert', patch });
          // The global unique index production enforces, regardless of which release (or artist)
          // holds the listing.
          if (table === 'release_sources' && patch.external_id &&
              rowsOf().some(r => r.platform === patch.platform && r.external_id === patch.external_id)) {
            const error = { code: '23505', message: 'duplicate key value violates unique constraint "idx_release_sources_external"' };
            return { select: () => ({ single: () => Promise.resolve({ data: null, error }) }) };
          }
          const row = { id: `${table}-new-${rowsOf().length + 1}`, detail_checked_at: null, ...patch };
          rowsOf().push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
        },
        delete() {
          return {
            eq: (_c: string, id: unknown) => {
              writes.push({ table, op: 'delete', patch: { id } });
              tables[table] = rowsOf().filter(r => r.id !== id);
              return Promise.resolve({ error: null });
            },
          };
        },
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({ data: matched(), error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

const captureMessage = vi.fn();
vi.mock('../../lib/sentry', () => ({ Sentry: { captureMessage, captureException: vi.fn() } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { persistFaircampReleases, persistMirloReleases, persistJamcoopReleases, persistReleases, persistDiscogsReleases } =
  await import('../db');

const ARTIST = 'a1';
const OTHER_ARTIST = 'label-row';

/**
 * Another artist row already holds this listing. Our artist has one unrelated release, plus —
 * when `withNearMiss` — one whose title is close enough to the incoming listing to be flagged.
 */
function seed(platform: string, externalId: string, { withNearMiss = false } = {}) {
  tables.releases = [
    { id: 'theirs', artist_id: OTHER_ARTIST, slug: 'quicksand', title: 'Quicksand', match_key: 'quicksand', release_type: 'album', curated_fields: null, needs_review: false },
    { id: 'mine', artist_id: ARTIST, slug: 'other-record', title: 'Other Record', match_key: 'otherrecord', release_type: 'album', curated_fields: null, needs_review: false },
    ...(withNearMiss
      ? [{ id: 'near', artist_id: ARTIST, slug: 'quicksand-ep', title: 'Quicksand EP', match_key: 'quicksandep', release_type: 'ep', curated_fields: null, needs_review: false }]
      : []),
  ];
  tables.release_sources = [
    { id: 's-theirs', release_id: 'theirs', platform, url: externalId, external_id: externalId, source: 'auto', detail_checked_at: null },
  ];
}

const listing = (externalUrl: string) => [{
  title: 'Quicksand',
  slug: 'quicksand',
  matchKey: 'quicksand',
  releaseType: 'album',
  releaseDate: null,
  datePrecision: 'unknown',
  status: 'released',
  artworkUrl: null,
  externalUrl,
}];

const myReleases = () => (tables.releases ?? []).filter(r => r.artist_id === ARTIST).map(r => r.id).sort();
const unsourced = () => (tables.releases ?? []).filter(r => !(tables.release_sources ?? []).some(s => s.release_id === r.id) && r.id !== 'mine' && r.id !== 'near');

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
  captureMessage.mockClear();
});

describe.each([
  ['faircamp', persistFaircampReleases, 'https://music.label.example/quicksand/'],
  ['mirlo', persistMirloReleases, 'https://mirlo.space/label/release/quicksand'],
  ['jamcoop', persistJamcoopReleases, 'https://jam.coop/artists/label/albums/quicksand'],
] as const)('a %s listing another artist already holds', (platform, persist, url) => {
  it('leaves no source-less release behind', async () => {
    seed(platform, url);

    const written = await persist(ARTIST, listing(url) as never);

    expect(written).toHaveLength(0);
    expect(myReleases()).toEqual(['mine']);
    expect(unsourced()).toHaveLength(0);
  });

  it('does not flag a near-miss partner for review', async () => {
    seed(platform, url, { withNearMiss: true });

    await persist(ARTIST, listing(url) as never);

    expect(tables.releases.find(r => r.id === 'near')?.needs_review).toBe(false);
    expect(myReleases()).toEqual(['mine', 'near']);
  });

  it('reports the discard to Sentry once per pass, tagged by platform', async () => {
    seed(platform, url);

    await persist(ARTIST, listing(url) as never);

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ tags: { platform }, extra: { artistId: ARTIST, count: 1 } });
  });

  it('still flags a near-miss partner when the new listing is genuinely new', async () => {
    seed(platform, url, { withNearMiss: true });

    await persist(ARTIST, listing(`${url}-not-theirs`) as never);

    expect(tables.releases.find(r => r.id === 'near')?.needs_review).toBe(true);
    expect(myReleases()).toHaveLength(3);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('a Bandcamp listing another artist row already holds', () => {
  const bandcamp = [{
    title: 'Quicksand',
    slug: 'quicksand',
    matchKey: 'quicksand',
    releaseType: 'album',
    releaseDate: '2021-02-20',
    datePrecision: 'day',
    status: 'released',
    artworkUrl: null,
    source: { platform: 'bandcamp', url: 'https://shared.bandcamp.com/album/quicksand', externalId: 'album-123' },
  }];

  it('leaves no source-less release behind', async () => {
    seed('bandcamp', 'album-123');

    const written = await persistReleases(ARTIST, bandcamp as never);

    expect(written).toHaveLength(0);
    expect(myReleases()).toEqual(['mine']);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe('a Discogs master already credited to another artist', () => {
  const discogs = [{
    title: 'Quicksand',
    slug: 'quicksand',
    matchKey: 'quicksand',
    releaseType: 'album',
    releaseDate: '2024-01-01',
    datePrecision: 'year',
    status: 'released',
    masterId: '2004040',
    mainReleaseId: '999',
  }];

  it('leaves no source-less release behind', async () => {
    seed('discogs', '2004040');

    const written = await persistDiscogsReleases(ARTIST, discogs as never);

    expect(written).toHaveLength(0);
    expect(myReleases()).toEqual(['mine']);
  });

  it('does not flag a near-miss partner for review', async () => {
    seed('discogs', '2004040', { withNearMiss: true });
    // Discogs only fuzzy-matches within a release type.
    tables.releases.find(r => r.id === 'near')!.release_type = 'album';

    await persistDiscogsReleases(ARTIST, discogs as never);

    expect(tables.releases.find(r => r.id === 'near')?.needs_review).toBe(false);
  });
});

describe('a release found by title whose source write fails', () => {
  it('is never deleted — only a row this pass inserted is', async () => {
    seed('faircamp', 'https://music.label.example/quicksand/');
    // Our artist already has the release by title (an older orphan, say); this pass inserts nothing.
    tables.releases.push({ id: 'existing-title-match', artist_id: ARTIST, slug: 'quicksand', title: 'Quicksand', match_key: 'quicksand', release_type: 'album', curated_fields: null });

    await persistFaircampReleases(ARTIST, listing('https://music.label.example/quicksand/') as never);

    expect(writes.filter(w => w.op === 'delete')).toHaveLength(0);
    expect(myReleases()).toContain('existing-title-match');
  });
});
