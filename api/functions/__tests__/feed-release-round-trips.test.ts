// How many database round trips the dashboard's release feed waits on, one after another.
//
// getFeedReleasesForUser backs /dashboard's Recent & Upcoming Releases and every calendar/RSS
// feed. It used to resolve the saved list, then the alias fallback, then the collection, then
// each hundred collection artists, then the releases — each step waiting for the last, so a
// fan with a large collection waited on six or more round trips in a row before the section
// could draw. The steps that don't depend on each other now run together.
//
// The fake client here holds every query until the test releases the whole batch in flight, so
// the number of batches is the number of sequential round trips. The outputs are pinned by
// saved-artist-resolution.test.ts and feed-collection-artists.test.ts; this file pins the depth.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter { kind: 'eq' | 'in' | 'gte' | 'order' | 'limit' | 'range'; column?: string; value?: unknown }

const tables: Record<string, Record<string, unknown>[]> = {
  saved_artists: [],
  collection_items: [],
  artists: [],
  artist_slug_aliases: [],
  releases: [],
};

/** Queries issued but not yet answered — released by the test one batch at a time. */
const held: (() => void)[] = [];

function makeClient() {
  return {
    from(table: string) {
      return {
        select() {
          const filters: Filter[] = [];
          const builder = {
            eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
            in(column: string, value: unknown) { filters.push({ kind: 'in', column, value }); return builder; },
            gte(column: string, value: unknown) { filters.push({ kind: 'gte', column, value }); return builder; },
            order(column: string) { filters.push({ kind: 'order', column }); return builder; },
            limit(value: number) { filters.push({ kind: 'limit', value }); return builder; },
            range(from: number, to: number) { filters.push({ kind: 'range', value: [from, to] }); return builder; },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              let rows = tables[table] ?? [];
              for (const f of filters) {
                if (f.kind === 'eq') rows = rows.filter(r => r[f.column as string] === f.value);
                if (f.kind === 'in') {
                  const wanted = new Set(f.value as unknown[]);
                  rows = rows.filter(r => wanted.has(r[f.column as string]));
                }
              }
              const range = filters.find(f => f.kind === 'range');
              if (range) {
                const [from, to] = range.value as [number, number];
                rows = rows.slice(from, to + 1);
              }
              const result = { data: rows, error: null };
              return new Promise(answer => held.push(() => answer(result))).then(resolve, reject);
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

/** Run `work`, answering every query in flight at once per round; return the rounds it took. */
async function countRoundTrips<T>(work: () => Promise<T>): Promise<{ rounds: number; result: T }> {
  let finished = false;
  let result: T | undefined;
  const running = work().then(r => { finished = true; result = r; });

  let rounds = 0;
  for (;;) {
    // A macrotask boundary: every continuation of the last batch has run and issued its next query.
    await new Promise(r => setTimeout(r, 0));
    if (finished) break;
    if (held.length === 0) throw new Error('feed read stalled with no query in flight');
    rounds++;
    for (const answer of held.splice(0)) answer();
  }
  await running;
  return { rounds, result: result as T };
}

const USER = 'user-1';
const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

function release(slug: string, artistId: string) {
  return {
    slug, title: slug, release_date: soon, date_precision: 'day', artwork_url: null,
    is_hidden: false, needs_review: false, artist_id: artistId,
    artists: { name: `Artist ${artistId}`, slug: artistId }, release_sources: [],
  };
}

beforeEach(() => {
  held.length = 0;
  for (const key of Object.keys(tables)) tables[key] = [];
});

describe('getFeedReleasesForUser — sequential round trips', () => {
  it('reads saved artists and the collection together: two round trips for a linked saved list', async () => {
    // Was three: saved_artists, then collection_items, then releases.
    tables.saved_artists = [{ user_id: USER, artist_id: 'a1', artist_slug: 'a1', artist_name: 'A1', deleted: false }];
    tables.releases = [release('first', 'a1')];

    const { rounds, result } = await countRoundTrips(() => getFeedReleasesForUser(USER));
    expect(result.map(r => r.releaseSlug)).toEqual(['first']);
    expect(rounds).toBe(2);
  });

  it('resolves unlinked saved slugs and their aliases in one round trip, not two', async () => {
    // Was five: saved_artists, artists, artist_slug_aliases, collection_items, releases.
    tables.saved_artists = [{ user_id: USER, artist_id: null, artist_slug: 'beyonc', artist_name: null, deleted: false }];
    tables.artists = [{ id: 'a2', slug: 'beyonce', name: 'Beyonce' }];
    tables.artist_slug_aliases = [{ alias: 'beyonc', artist_id: 'a2' }];
    tables.releases = [release('renaissance', 'a2')];

    const { rounds, result } = await countRoundTrips(() => getFeedReleasesForUser(USER));
    expect(result.map(r => r.releaseSlug)).toEqual(['renaissance']);
    expect(rounds).toBe(3);
  });

  it('looks up every hundred collection artists at once', async () => {
    // 250 collection artists that matched no release: three slug chunks. Was six round trips
    // (saved_artists, collection_items, three chunks, releases); now the chunks are one.
    tables.collection_items = Array.from({ length: 250 }, (_, i) => ({
      user_id: USER, artist_name: `Collected ${i}`, releases: null,
    }));
    tables.artists = [{ id: 'c249', slug: 'collected-249' }];
    tables.releases = [release('deep-cut', 'c249')];

    const { rounds, result } = await countRoundTrips(() => getFeedReleasesForUser(USER));
    expect(result.map(r => r.releaseSlug)).toEqual(['deep-cut']);
    expect(rounds).toBe(3);
  });

  it('caps the slug lookups in flight, so a huge collection costs an extra round, not a burst', async () => {
    // 650 artists is seven chunks: five at once, then the other two.
    tables.collection_items = Array.from({ length: 650 }, (_, i) => ({
      user_id: USER, artist_name: `Collected ${i}`, releases: null,
    }));
    tables.artists = [{ id: 'c649', slug: 'collected-649' }];
    tables.releases = [release('last-chunk', 'c649')];

    const { rounds, result } = await countRoundTrips(() => getFeedReleasesForUser(USER));
    expect(result.map(r => r.releaseSlug)).toEqual(['last-chunk']);
    expect(rounds).toBe(4);
  });

  it('still uses an alias only for a slug nothing else resolved', async () => {
    // The alias read now covers every unlinked slug so it can run alongside the artists read.
    // A slug that resolved directly must not also pick up whatever an alias row says.
    tables.saved_artists = [{ user_id: USER, artist_id: null, artist_slug: 'rodney-owl', artist_name: null, deleted: false }];
    tables.artists = [{ id: 'a1', slug: 'rodney-owl', name: 'Rodney Owl' }];
    tables.artist_slug_aliases = [{ alias: 'rodney-owl', artist_id: 'someone-else' }];
    tables.releases = [release('owl', 'a1'), release('not-theirs', 'someone-else')];

    const { result } = await countRoundTrips(() => getFeedReleasesForUser(USER));
    expect(result.map(r => r.releaseSlug)).toEqual(['owl']);
  });
});
