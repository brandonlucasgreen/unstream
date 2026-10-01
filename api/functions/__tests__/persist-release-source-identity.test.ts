// A platform listing that is already a source on one of the artist's releases *is* that release,
// whatever its title now says.
//
// Found 2026-10-01: every pair in /admin/release-review was a phantom made by the scheduled
// re-catalogue. Faircamp and Mirlo list "Luminaires" as "Luminaires (single)"; the title no longer
// matched the stored release's match_key, so ingest inserted a new row and flagged the pair, then
// the source write for that row hit UNIQUE (platform, external_id) — the listing already belonged
// to the original — and failed. The result was a release with no sources, flagged for review.
// Merging it deleted it until the next sweep made it again.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
const writes: { table: string; op: 'update' | 'insert'; patch: Row }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const rowsOf = () => (tables[table] ??= []);
      const matched = () => rowsOf().filter(r => eqs.every(([c, v]) => r[c] === v));

      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return builder; },
        in() { return builder; },
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
          const row = { id: `${table}-new-${rowsOf().length + 1}`, detail_checked_at: null, ...patch };
          rowsOf().push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
        },
        maybeSingle() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({ data: matched(), error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { persistFaircampReleases, persistMirloReleases, persistJamcoopReleases, persistReleases } = await import('../db');

const ARTIST = 'a1';

/** The release a previous pass left behind, already holding `platform`'s listing as a source. */
function seed(platform: string, externalId: string) {
  tables.releases = [{
    id: 'r1',
    artist_id: ARTIST,
    slug: 'luminaires',
    title: 'Luminaires',
    match_key: 'luminaires',
    release_type: 'single',
    release_date: '2026-06-21',
    date_precision: 'day',
    artwork_url: 'https://img/art.jpg',
    curated_fields: null,
  }];
  tables.release_sources = [{
    id: 's1',
    release_id: 'r1',
    platform,
    url: externalId,
    external_id: externalId,
    source: 'auto',
    detail_checked_at: null,
  }];
}

/** The same listing, as the platform titles it now. */
function retitled(externalUrl: string, overrides: Row = {}) {
  return [{
    title: 'Luminaires (single)',
    slug: 'luminaires-single',
    matchKey: 'luminairessingle',
    releaseType: 'single',
    releaseDate: '2026-06-21',
    datePrecision: 'day',
    status: 'released',
    artworkUrl: 'https://img/other-cdn.jpg',
    externalUrl,
    ...overrides,
  }];
}

const releaseInserts = () => writes.filter(w => w.table === 'releases' && w.op === 'insert');
const reviewFlags = () => writes.filter(w => w.table === 'releases' && w.patch.needs_review === true);

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
});

describe.each([
  ['faircamp', persistFaircampReleases, 'https://music.lminiero.it/luminaires/'],
  ['mirlo', persistMirloReleases, 'https://mirlo.space/lminiero/release/luminaires-single'],
  ['jamcoop', persistJamcoopReleases, 'https://jam.coop/artists/lminiero/albums/luminaires'],
] as const)('a %s listing already on a release, now titled differently', (platform, persist, url) => {
  it('resolves to that release instead of inserting a new one', async () => {
    seed(platform, url);

    const written = await persist(ARTIST, retitled(url) as never);

    expect(releaseInserts()).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0].releaseId).toBe('r1');
  });

  it('flags nothing for review', async () => {
    seed(platform, url);

    await persist(ARTIST, retitled(url) as never);

    expect(reviewFlags()).toHaveLength(0);
  });

  it('still flags a genuinely new listing whose title is merely close', async () => {
    seed(platform, url);

    await persist(ARTIST, retitled(`${url}-remixes`, {
      title: 'Luminaires Remixes',
      slug: 'luminaires-remixes',
      matchKey: 'luminairesremixes',
    }) as never);

    // The source check must not have swallowed tier 3: a different listing is a different
    // release, and a close title is still a human's call.
    expect(releaseInserts()).toHaveLength(1);
    expect(reviewFlags().length).toBeGreaterThan(0);
  });
});

describe('a Bandcamp listing already on a release, now titled differently', () => {
  const bandcamp = (title: string, matchKey: string) => [{
    title,
    slug: 'luminaires',
    matchKey,
    releaseType: 'single',
    releaseDate: '2026-06-21',
    datePrecision: 'day',
    status: 'released',
    artworkUrl: 'https://img/art.jpg',
    source: { platform: 'bandcamp', url: 'https://lminiero.bandcamp.com/track/luminaires', externalId: 'track-321020101' },
  }];

  it('resolves to that release, and keeps the stored title so it still matches match_key', async () => {
    seed('bandcamp', 'track-321020101');

    const written = await persistReleases(ARTIST, bandcamp('Luminaires (single)', 'luminairessingle') as never);

    expect(releaseInserts()).toHaveLength(0);
    expect(written[0].releaseId).toBe('r1');
    expect(tables.releases[0].title).toBe('Luminaires');
  });

  it('still takes a title change that normalizes to the same match key', async () => {
    seed('bandcamp', 'track-321020101');

    await persistReleases(ARTIST, bandcamp('LUMINAIRES', 'luminaires') as never);

    expect(tables.releases[0].title).toBe('LUMINAIRES');
  });
});
