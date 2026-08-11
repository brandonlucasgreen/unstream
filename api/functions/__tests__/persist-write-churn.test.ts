// persistSearchResults used to write on every search whether or not anything had changed: one
// upsert of the `artists` row (five indexes, one of them a GIN trigram index) plus a bulk upsert of
// every one of that artist's link rows. Searching an artist we already knew perfectly was pure
// write churn, and Postgres has no in-place update — every one of those was a new tuple version,
// fresh index entries, WAL, and a dead tuple for autovacuum.
//
// What these tests pin is the *shape* of the fix, because it has a trap in it. `artists.updated_at`
// is not "when the data changed" — getArtistBySlug reads it as "when we last verified this artist"
// and refuses the row after FRESHNESS_TTL_MS. So the write cannot simply be skipped when nothing
// differs; it has to be throttled, and the throttle has to stay well inside the freshness window.
// Both halves are asserted below.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
/** Every write the code attempted, so a skipped write is observable rather than inferred. */
const writes: { table: string; rows: Row[] }[] = [];
/** Set to a message to make the artist_links read fail. */
const linkReadError = { value: null as string | null };

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
        or() { return builder; },
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        maybeSingle() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        upsert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          writes.push({ table, rows: list });
          for (const r of list) {
            const key = table === 'artists' ? 'slug' : 'platform';
            const existingIndex = rowsOf().findIndex(
              e => e[key] === r[key] && (table === 'artists' || e.artist_id === r.artist_id)
            );
            if (existingIndex >= 0) rowsOf()[existingIndex] = { ...rowsOf()[existingIndex], ...r };
            else rowsOf().push({ id: `${table}-${rowsOf().length + 1}`, ...r });
          }
          const written = rowsOf().find(e => e[table === 'artists' ? 'slug' : 'platform'] === list[0][table === 'artists' ? 'slug' : 'platform']);
          return {
            select: () => ({ single: () => Promise.resolve({ data: written, error: null }) }),
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res),
          };
        },
        then(res: (v: unknown) => unknown) {
          if (table === 'artist_links' && linkReadError.value) {
            return Promise.resolve({ data: null, error: { message: linkReadError.value } }).then(res);
          }
          return Promise.resolve({ data: matched(), error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
vi.mock('../request-catalog', () => ({ requestArtistCatalog: async () => true }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { persistSearchResults } = await import('../db');

const BANDCAMP = 'https://bigthief.bandcamp.com';

function result(overrides: { name?: string; imageUrl?: string | null; url?: string } = {}) {
  return {
    id: 'r1',
    name: overrides.name ?? 'Big Thief',
    type: 'artist' as const,
    imageUrl: overrides.imageUrl === undefined ? 'https://img/1.jpg' : overrides.imageUrl,
    matchConfidence: 'verified' as const,
    platforms: [{ sourceId: 'bandcamp', url: overrides.url ?? BANDCAMP }],
  };
}

/** The artist row a previous search would have left behind. */
function seedArtist(agoMs: number, overrides: Row = {}) {
  tables.artists = [{
    id: 'a1',
    // artistSlug('Big Thief') — hyphenated, not squashed.
    slug: 'big-thief',
    name: 'Big Thief',
    image_url: 'https://img/1.jpg',
    match_confidence: 'verified',
    updated_at: new Date(Date.now() - agoMs).toISOString(),
    ...overrides,
  }];
  tables.artist_links = [{
    id: 'l1',
    artist_id: 'a1',
    platform: 'bandcamp',
    url: BANDCAMP,
    source: 'search',
    is_direct: true,
    latest_release: null,
    display_order: 0,
  }];
}

const writesTo = (table: string) => writes.filter(w => w.table === table);

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
  linkReadError.value = null;
});

describe('an artist we already know, unchanged', () => {
  it('writes nothing at all when the row was refreshed recently', async () => {
    seedArtist(5 * 60 * 1000); // five minutes ago

    await persistSearchResults([result()] as never);

    expect(writesTo('artists')).toHaveLength(0);
    expect(writesTo('artist_links')).toHaveLength(0);
  });

  // The other half of the fix. `updated_at` is a freshness signal with a 24-hour TTL, so it still
  // has to advance — an unchanged row is refreshed once an hour rather than once a search. If this
  // fails, stored artist cards silently expire and every search re-runs the full live pipeline.
  it('still refreshes updated_at once the throttle window has passed', async () => {
    seedArtist(2 * 60 * 60 * 1000); // two hours ago

    await persistSearchResults([result()] as never);

    expect(writesTo('artists')).toHaveLength(1);
    const stamped = writesTo('artists')[0].rows[0].updated_at as string;
    expect(Date.now() - new Date(stamped).getTime()).toBeLessThan(5000);
  });

  it('keeps the throttle well inside the 24-hour freshness window', async () => {
    // 23 hours: past the throttle, still inside freshness — so the refresh must already have
    // happened long before a row could expire.
    seedArtist(23 * 60 * 60 * 1000);
    await persistSearchResults([result()] as never);
    expect(writesTo('artists')).toHaveLength(1);
  });

  // A missing or unparseable timestamp must mean "write it", never "never write it again".
  it('treats an unusable updated_at as due for a refresh', async () => {
    seedArtist(0, { updated_at: 'not a date' });
    await persistSearchResults([result()] as never);
    expect(writesTo('artists')).toHaveLength(1);

    writes.length = 0;
    seedArtist(0, { updated_at: null });
    await persistSearchResults([result()] as never);
    expect(writesTo('artists')).toHaveLength(1);
  });
});

describe('an artist whose data actually changed', () => {
  it('writes immediately on a new name, throttle or not', async () => {
    seedArtist(5 * 60 * 1000);
    await persistSearchResults([result({ name: 'Big Thief!' })] as never);
    expect(writesTo('artists')).toHaveLength(1);
  });

  it('writes immediately on a new image', async () => {
    seedArtist(5 * 60 * 1000);
    await persistSearchResults([result({ imageUrl: 'https://img/2.jpg' })] as never);
    expect(writesTo('artists')).toHaveLength(1);
  });

  it('writes immediately when the pipeline verdict changed', async () => {
    seedArtist(5 * 60 * 1000, { match_confidence: 'unverified' });
    await persistSearchResults([result()] as never);
    expect(writesTo('artists')).toHaveLength(1);
  });
});

describe('link rows', () => {
  it('writes only the links that differ', async () => {
    seedArtist(5 * 60 * 1000);
    // Two platforms: bandcamp is unchanged, mirlo is new.
    const withMirlo = {
      ...result(),
      platforms: [
        { sourceId: 'bandcamp', url: BANDCAMP },
        { sourceId: 'mirlo', url: 'https://mirlo.space/bigthief' },
      ],
    };

    await persistSearchResults([withMirlo] as never);

    const linkWrites = writesTo('artist_links');
    expect(linkWrites).toHaveLength(1);
    expect(linkWrites[0].rows).toHaveLength(1);
    expect(linkWrites[0].rows[0].platform).toBe('mirlo');
  });

  it('writes a link whose URL moved', async () => {
    seedArtist(5 * 60 * 1000);
    await persistSearchResults([result({ url: 'https://bigthief-music.bandcamp.com' })] as never);

    const linkWrites = writesTo('artist_links');
    expect(linkWrites).toHaveLength(1);
    expect(linkWrites[0].rows[0].url).toBe('https://bigthief-music.bandcamp.com');
  });

  // Failing towards "write it" keeps the old behaviour. Skipping writes because a *read* failed
  // would silently drop a real update.
  it('writes every link when the comparison read fails', async () => {
    seedArtist(5 * 60 * 1000);
    linkReadError.value = 'connection reset';

    await persistSearchResults([result()] as never);

    expect(writesTo('artist_links')).toHaveLength(1);
    expect(writesTo('artist_links')[0].rows).toHaveLength(1);
  });
});

describe('an artist we have never seen', () => {
  it('writes the artist and all of its links', async () => {
    tables.artists = [];
    tables.artist_links = [];

    await persistSearchResults([result()] as never);

    expect(writesTo('artists')).toHaveLength(1);
    expect(writesTo('artist_links')).toHaveLength(1);
    expect(writesTo('artist_links')[0].rows).toHaveLength(1);
  });
});
