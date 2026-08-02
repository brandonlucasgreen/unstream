// The reads and the write behind manual release ordering.
//
// What's worth locking down is that the sort happens **in SQL, display_order first**. Both
// artist-page reads are limited (60 for the SPA payload, 24 for the crawler render), so a
// well-meaning refactor that fetched by date and re-sorted in JS would silently drop a release
// the artist had pinned to the top out of the query altogether — the arrangement would look
// obeyed on a short catalogue and lose records on a long one.
//
// `nullsFirst: false` is the other half: display_order is null for every release until an artist
// arranges one, so NULLS LAST is what keeps this inert for everyone who never touches it, and is
// also what puts a release catalogued later at the end of an existing arrangement instead of on
// top of it.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// release-detail-query.test.ts, because the point is to exercise the real query body.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OrderCall {
  table: string;
  column: string;
  options: { ascending: boolean; nullsFirst?: boolean };
}

const orders: OrderCall[] = [];
const selects: string[] = [];
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];

type QueryResult = { data: unknown[]; count: number; error: null };

interface Builder extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): Builder;
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): Builder;
  limit(n: number): Builder;
}

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          selects.push(columns);
          const builder: Builder = {
            eq: () => builder,
            order(column, options) {
              orders.push({ table, column, options });
              return builder;
            },
            limit: () => builder,
            then: (resolve, reject) =>
              Promise.resolve<QueryResult>({ data: [], count: 0, error: null }).then(resolve, reject),
          };
          return builder;
        },
      };
    },
    rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      return Promise.resolve({ error: null });
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { getArtistReleases, getArtistReleasesForOwner, setReleaseDisplayOrder } = await import('../db');

/** The ordering both artist-page renderers must apply, and must keep applying identically. */
const EXPECTED_ORDER = [
  { column: 'display_order', options: { ascending: true, nullsFirst: false } },
  { column: 'release_date', options: { ascending: false, nullsFirst: false } },
  { column: 'created_at', options: { ascending: false } },
];

beforeEach(() => {
  orders.length = 0;
  selects.length = 0;
  rpcCalls.length = 0;
});

describe('the public artist-page read', () => {
  it('sorts by the artist\'s arrangement first, then newest, in the query itself', async () => {
    await getArtistReleases('artist-1', 60);
    expect(orders.map(o => ({ column: o.column, options: o.options }))).toEqual(EXPECTED_ORDER);
  });
});

describe('the owner\'s editing read', () => {
  it('applies the same ordering, so the editor shows what fans see', async () => {
    await getArtistReleasesForOwner('artist-1');
    expect(orders.map(o => ({ column: o.column, options: o.options }))).toEqual(EXPECTED_ORDER);
  });

  // The page decides whether to offer "Reset to newest first" from this field. Without it, an
  // artist who has arranged their catalogue has no way back to date order.
  it('returns display_order, so the editor can tell an arrangement exists', async () => {
    await getArtistReleasesForOwner('artist-1');
    expect(selects[0]).toContain('display_order');
  });
});

describe('storing an arrangement', () => {
  // One RPC, one transaction: a half-written order is an arrangement the artist never chose,
  // live on their public page.
  it('goes through the transactional RPC with the ids in order', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    await expect(setReleaseDisplayOrder('artist-1', ids)).resolves.toBe(true);
    expect(rpcCalls).toEqual([
      { name: 'set_release_display_order', params: { p_artist_id: 'artist-1', p_release_ids: ids } },
    ]);
  });

  // An empty arrangement is how "reset to newest first" reaches the database — the function
  // clears every position that isn't in the array it was given.
  it('sends an empty array through unchanged for a reset', async () => {
    await setReleaseDisplayOrder('artist-1', []);
    expect(rpcCalls[0].params.p_release_ids).toEqual([]);
  });
});
