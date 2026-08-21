// Which saved artists a fan's feed can actually see.
//
// The bug this guards, found 2026-08-07 the hour /dashboard's Recent Releases shipped: the feed
// keyed on `saved_artists.artist_id` alone, and **25 of 37 live rows have it NULL** because a save
// made from a search result sent a synthetic key (`rodneyowl`, `qobuz-pearljam`, `nameonly-…`)
// that matched no artists row. Two thirds of every fan's saved list was invisible to their feed,
// their calendar and their dashboard — and it looked exactly like "those artists have nothing new".
//
// Driven against a recording fake Supabase client rather than a module mock, following
// recatalog-sweep-selection.test.ts, so the real query body runs — the `deleted` filter and the
// fallback chain are the things under test, and a module mock would assert my own fake.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter { kind: 'eq' | 'in' | 'gte' | 'order' | 'limit' | 'range'; column?: string; value?: unknown }
interface Query { table: string; columns: string; filters: Filter[] }

const queries: Query[] = [];

const tables: Record<string, Record<string, unknown>[]> = {
  saved_artists: [],
  artists: [],
  artist_slug_aliases: [],
  releases: [],
  // Empty in every case here: the feed's collection half has its own file
  // (feed-collection-artists.test.ts). It still has to answer, because the feed now reads it.
  collection_items: [],
};

/** Set to a table name to make that table's read fail. */
let failingTable: string | null = null;

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const query: Query = { table, columns, filters: [] };
          queries.push(query);

          const builder = {
            eq(column: string, value: unknown) { query.filters.push({ kind: 'eq', column, value }); return builder; },
            in(column: string, value: unknown) { query.filters.push({ kind: 'in', column, value }); return builder; },
            gte(column: string, value: unknown) { query.filters.push({ kind: 'gte', column, value }); return builder; },
            order(column: string, value: unknown) { query.filters.push({ kind: 'order', column, value }); return builder; },
            limit(value: number) { query.filters.push({ kind: 'limit', value }); return builder; },
            range(from: number, to: number) { query.filters.push({ kind: 'range', value: [from, to] }); return builder; },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              if (failingTable === table) {
                return Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve, reject);
              }
              let rows = tables[table] ?? [];
              for (const f of query.filters) {
                if (f.kind === 'eq') rows = rows.filter(r => r[f.column as string] === f.value);
                if (f.kind === 'in') {
                  const wanted = new Set(f.value as unknown[]);
                  rows = rows.filter(r => wanted.has(r[f.column as string]));
                }
              }
              const range = query.filters.find(f => f.kind === 'range');
              if (range) {
                const [from, to] = range.value as [number, number];
                rows = rows.slice(from, to + 1);
              }
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { getFeedReleasesForUser } = await import('../db');

const USER = 'user-1';

function savedRow(over: Record<string, unknown> = {}) {
  return { artist_id: null, artist_slug: null, artist_name: null, user_id: USER, deleted: false, ...over };
}

/** A release row shaped as FEED_SELECT returns it. */
function releaseRow(artistId: string, title = 'Loneliness Is Contagious') {
  return {
    artist_id: artistId,
    slug: 'loneliness-is-contagious',
    title,
    release_date: '2026-08-06',
    date_precision: 'day',
    artwork_url: null,
    is_hidden: false,
    needs_review: false,
    artists: { name: 'Rodney Owl', slug: 'rodney-owl' },
    release_sources: [],
  };
}

beforeEach(() => {
  queries.length = 0;
  failingTable = null;
  for (const key of Object.keys(tables)) tables[key] = [];
});

describe('getFeedReleasesForUser — resolving who is saved', () => {
  it('finds an artist saved with a linked artist_id', async () => {
    tables.saved_artists = [savedRow({ artist_id: 'a1', artist_slug: 'rodney-owl' })];
    tables.releases = [releaseRow('a1')];

    const out = await getFeedReleasesForUser(USER);
    expect(out.map(r => r.title)).toEqual(['Loneliness Is Contagious']);
  });

  // The actual Rodney Owl bug: saved from a search result, so artist_id is NULL and the stored
  // slug is the synthetic key. Before the fix this returned [].
  it('resolves a row whose artist_id is NULL via its artist_slug', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'rodney-owl' })];
    tables.artists = [{ id: 'a1', slug: 'rodney-owl', name: 'Rodney Owl' }];
    tables.releases = [releaseRow('a1')];

    const out = await getFeedReleasesForUser(USER);
    expect(out.map(r => r.title)).toEqual(['Loneliness Is Contagious']);
  });

  // A slug retired by the accent-folding reslug (#410) is the other way a stored slug stops
  // matching — 44 aliases exist in production.
  it('resolves a retired slug through artist_slug_aliases', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'beyonc' })];
    tables.artists = [{ id: 'a2', slug: 'beyonce', name: 'Beyonce' }];
    tables.artist_slug_aliases = [{ alias: 'beyonc', artist_id: 'a2' }];
    tables.releases = [releaseRow('a2', 'Renaissance')];

    const out = await getFeedReleasesForUser(USER);
    expect(out.map(r => r.title)).toEqual(['Renaissance']);
  });

  // What the production rows actually look like: a squashed name, no hyphen, matching no slug
  // and no alias. Re-deriving artistSlug(artist_name) is the only thing that recovers them.
  it('resolves a synthetic key by re-deriving the slug from the saved name', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'rodneyowl', artist_name: 'Rodney Owl' })];
    tables.artists = [{ id: 'a1', slug: 'rodney-owl', name: 'Rodney Owl' }];
    tables.releases = [releaseRow('a1')];

    const out = await getFeedReleasesForUser(USER);
    expect(out.map(r => r.title)).toEqual(['Loneliness Is Contagious']);
  });

  it('resolves a platform-prefixed key the same way', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'qobuz-robertlogan', artist_name: 'Robert Logan' })];
    tables.artists = [{ id: 'a4', slug: 'robert-logan', name: 'Robert Logan' }];
    tables.releases = [releaseRow('a4', 'Cognition')];

    const out = await getFeedReleasesForUser(USER);
    expect(out.map(r => r.title)).toEqual(['Cognition']);
  });

  // A name is a far weaker key than a slug, so a name-derived hit has to prove itself. Putting an
  // unrelated artist's record in someone's calendar is worse than showing nothing.
  it('refuses a name-derived match whose artist name does not agree', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'nameonly-blixbyrd', artist_name: 'Music' })];
    // A real artist whose vanity slug happens to be 'music' but who is called something else.
    tables.artists = [{ id: 'a5', slug: 'music', name: 'The Music Tapes' }];
    tables.releases = [releaseRow('a5')];

    const out = await getFeedReleasesForUser(USER);
    expect(out).toEqual([]);
  });

  it('leaves a genuinely unresolvable key out rather than guessing', async () => {
    tables.saved_artists = [savedRow({ artist_id: null, artist_slug: 'qobuz-pearljam', artist_name: 'Qobuz Pearljam' })];
    tables.artists = [{ id: 'a3', slug: 'pearl-jam', name: 'Pearl Jam' }];
    tables.releases = [releaseRow('a3')];

    const out = await getFeedReleasesForUser(USER);
    expect(out).toEqual([]);
  });

  // Tombstones: saved_artists keeps a row when you unsave (migration 017). Without the filter an
  // artist you removed keeps feeding your calendar forever.
  it('ignores an unsaved (tombstoned) artist', async () => {
    tables.saved_artists = [savedRow({ artist_id: 'a1', artist_slug: 'rodney-owl', deleted: true })];
    tables.releases = [releaseRow('a1')];

    const out = await getFeedReleasesForUser(USER);
    expect(out).toEqual([]);
    const savedQuery = queries.find(q => q.table === 'saved_artists');
    expect(savedQuery?.filters).toContainEqual({ kind: 'eq', column: 'deleted', value: false });
  });

  it('does not double-count an artist saved twice under two keys', async () => {
    tables.saved_artists = [
      savedRow({ artist_id: 'a1', artist_slug: 'bird-streets' }),
      savedRow({ artist_id: null, artist_slug: 'birdstreets' }),
    ];
    tables.artists = [{ id: 'a1', slug: 'birdstreets', name: 'Bird Streets' }];
    tables.releases = [releaseRow('a1')];

    const out = await getFeedReleasesForUser(USER);
    expect(out).toHaveLength(1);
    const releaseQuery = queries.find(q => q.table === 'releases');
    const idFilter = releaseQuery?.filters.find(f => f.kind === 'in');
    expect(idFilter?.value).toEqual(['a1']);
  });

  it('still returns the linked artists when slug resolution fails', async () => {
    tables.saved_artists = [
      savedRow({ artist_id: 'a1', artist_slug: 'rodney-owl' }),
      savedRow({ artist_id: null, artist_slug: 'someone-else' }),
    ];
    tables.releases = [releaseRow('a1')];
    failingTable = 'artists';

    const out = await getFeedReleasesForUser(USER);
    expect(out).toHaveLength(1);
  });

  it('returns nothing when the saved-artists read itself fails', async () => {
    tables.saved_artists = [savedRow({ artist_id: 'a1' })];
    tables.releases = [releaseRow('a1')];
    failingTable = 'saved_artists';

    expect(await getFeedReleasesForUser(USER)).toEqual([]);
  });

  it('skips the release query entirely when nothing is saved', async () => {
    const out = await getFeedReleasesForUser(USER);
    expect(out).toEqual([]);
    expect(queries.find(q => q.table === 'releases')).toBeUndefined();
  });
});
