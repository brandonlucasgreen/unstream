// Whose releases reach a fan's dashboard feed.
//
// Reversed 2026-08-16 (Brandon): "Collection Imports should always add to the collection NOT
// saved artists. However, you should get upcoming/recent release information from artists both
// in the collection and the saved artists list." Before this, the Bandcamp import conscripted
// every matched artist into saved_artists, which is what made their releases show up at all —
// so removing that write would have silently emptied the feed for anyone who imported. The
// union here is what keeps the promise while the two lists stay separate.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// recatalog-sweep-selection.test.ts, so the real query body runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter {
  kind: 'eq' | 'in' | 'range' | 'gte' | 'order' | 'limit';
  column?: string;
  value?: unknown;
}

interface Query {
  table: string;
  columns: string;
  filters: Filter[];
}

const queries: Query[] = [];

const tables: Record<string, Record<string, unknown>[]> = {
  saved_artists: [],
  collection_items: [],
  artists: [],
  artist_slug_aliases: [],
  releases: [],
};

let failingTable: string | null = null;

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const query: Query = { table, columns, filters: [] };
          queries.push(query);

          const builder = {
            eq(column: string, value: unknown) {
              query.filters.push({ kind: 'eq', column, value });
              return builder;
            },
            in(column: string, value: unknown) {
              query.filters.push({ kind: 'in', column, value });
              return builder;
            },
            gte(column: string, value: unknown) {
              query.filters.push({ kind: 'gte', column, value });
              return builder;
            },
            order(column: string) {
              query.filters.push({ kind: 'order', column });
              return builder;
            },
            limit(value: number) {
              query.filters.push({ kind: 'limit', value });
              return builder;
            },
            range(from: number, to: number) {
              query.filters.push({ kind: 'range', value: [from, to] });
              return builder;
            },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              if (failingTable === table) {
                return Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve, reject);
              }

              let rows = tables[table] ?? [];
              for (const f of query.filters) {
                if (f.kind === 'in') {
                  const wanted = new Set(f.value as string[]);
                  rows = rows.filter(r => wanted.has(r[f.column as string] as string));
                } else if (f.kind === 'eq') {
                  rows = rows.filter(r => r[f.column as string] === f.value);
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

/** Dated inside the feed's trailing window so it isn't filtered on date. */
const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

function release(id: string, artistId: string) {
  return {
    id,
    title: `Release ${id}`,
    slug: id,
    release_date: soon,
    date_precision: 'day',
    status: 'released',
    artwork_url: null,
    is_hidden: false,
    needs_review: false,
    artist_id: artistId,
    artists: { name: `Artist ${artistId}`, slug: artistId },
  };
}

describe('getFeedReleasesForUser — saved artists and collection artists', () => {
  beforeEach(() => {
    queries.length = 0;
    failingTable = null;
    for (const key of Object.keys(tables)) tables[key] = [];
  });

  it('includes releases by an artist that is only in the collection', async () => {
    // Nothing saved at all — the state a fan is in right after an import now that the sync
    // no longer writes saved_artists.
    tables.collection_items = [{ user_id: 'user-1', artist_name: 'Sufjan Stevens', releases: { artist_id: 'artist-1' } }];
    tables.releases = [release('illinois', 'artist-1')];

    const rows = await getFeedReleasesForUser('user-1');
    expect(rows.map(r => r.releaseSlug)).toEqual(['illinois']);
  });

  it('resolves a collection artist by derived slug when no release matched', async () => {
    // 72% of a real import matches no release, so the slug path is the common one.
    tables.collection_items = [{ user_id: 'user-1', artist_name: 'Anne Sulikowski', releases: null }];
    tables.artists = [{ id: 'artist-2', slug: 'anne-sulikowski' }];
    tables.releases = [release('tape', 'artist-2')];

    const rows = await getFeedReleasesForUser('user-1');
    expect(rows.map(r => r.releaseSlug)).toEqual(['tape']);
  });

  it('unions both lists without duplicating a shared artist', async () => {
    tables.saved_artists = [{ user_id: 'user-1', artist_id: 'artist-1', artist_slug: 'sufjan-stevens', artist_name: 'Sufjan Stevens', deleted: false }];
    tables.collection_items = [
      { user_id: 'user-1', artist_name: 'Sufjan Stevens', releases: { artist_id: 'artist-1' } },
      { user_id: 'user-1', artist_name: 'Mirah', releases: { artist_id: 'artist-3' } },
    ];
    tables.releases = [release('illinois', 'artist-1'), release('advisory', 'artist-3')];

    const rows = await getFeedReleasesForUser('user-1');
    expect(rows.map(r => r.releaseSlug).sort()).toEqual(['advisory', 'illinois']);

    // One query, one id list — the artist in both lists must not be asked for twice.
    const releaseQuery = queries.find(q => q.table === 'releases');
    const ids = releaseQuery?.filters.find(f => f.kind === 'in')?.value as string[];
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('still returns saved-artist releases when the collection read fails', async () => {
    // The collection is an addition to the feed; a failure there must narrow it, never blank it.
    tables.saved_artists = [{ user_id: 'user-1', artist_id: 'artist-1', artist_slug: 'sufjan-stevens', artist_name: 'Sufjan Stevens', deleted: false }];
    tables.releases = [release('illinois', 'artist-1')];
    failingTable = 'collection_items';

    const rows = await getFeedReleasesForUser('user-1');
    expect(rows.map(r => r.releaseSlug)).toEqual(['illinois']);
  });

  it('returns nothing when the fan has neither saved artists nor a collection', async () => {
    tables.releases = [release('illinois', 'artist-1')];
    expect(await getFeedReleasesForUser('user-1')).toEqual([]);
  });
});
