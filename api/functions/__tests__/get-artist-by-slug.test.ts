// getArtistBySlug runs at the front of every search (twice per web search: /api/search/stored
// and Phase 1 both call it). It used to find case variants with `slug.ilike.<slug>`, which no
// index can serve, so every call was a sequential scan of `artists`. It now lowercases the input
// and asks for the variants with `in`, which the slug's unique index answers. These pin that the
// query stays index-shaped and that the variants it used to find are still found.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
const artistQueries: { op: string; column?: string; values?: unknown[] }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const filters: { column: string; values: unknown[] }[] = [];
      const builder: Record<string, unknown> = {
        select() { return builder; },
        order() { return builder; },
        eq(column: string, value: unknown) { filters.push({ column, values: [value] }); return builder; },
        in(column: string, values: unknown[]) {
          if (table === 'artists') artistQueries.push({ op: 'in', column, values });
          filters.push({ column, values });
          return builder;
        },
        or() {
          if (table === 'artists') artistQueries.push({ op: 'or' });
          return builder;
        },
        single() {
          const rows = (tables[table] ?? []).filter(r => filters.every(f => f.values.includes(r[f.column])));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(res: (v: unknown) => unknown) {
          const rows = (tables[table] ?? []).filter(r => filters.every(f => f.values.includes(r[f.column])));
          return Promise.resolve({ data: rows, error: null }).then(res);
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

const { getArtistBySlug } = await import('../db');

const now = () => new Date().toISOString();
const artist = (id: string, slug: string, name: string): Row => ({
  id, slug, name, image_url: null, match_confidence: 'verified', source: 'auto',
  updated_at: now(), last_enriched_at: null, city: null, country: null, country_code: null,
});

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  artistQueries.length = 0;
  tables.artists = [
    artist('a1', 'king-triumph', 'King Triumph'),
    artist('a2', 'bigthief', 'Big Thief'),
  ];
  tables.artist_links = [];
});

describe('getArtistBySlug', () => {
  it('looks the slug up with one index-friendly in() and no ilike', async () => {
    const result = await getArtistBySlug('king-triumph');

    expect(result?.name).toBe('King Triumph');
    expect(artistQueries).toHaveLength(1);
    expect(artistQueries[0]).toMatchObject({ op: 'in', column: 'slug' });
  });

  it('still matches a slug typed in another case', async () => {
    const result = await getArtistBySlug('King-Triumph');

    expect(result?.name).toBe('King Triumph');
    expect(artistQueries[0].values).toContain('king-triumph');
  });

  it('still matches with hyphens stripped, whatever the case', async () => {
    expect((await getArtistBySlug('big-thief'))?.name).toBe('Big Thief');
    expect((await getArtistBySlug('Big-Thief'))?.name).toBe('Big Thief');
  });

  it('still matches with hyphens added at camelCase boundaries', async () => {
    expect((await getArtistBySlug('kingTriumph'))?.name).toBe('King Triumph');
  });

  it('rejects a slug that cannot exist without querying', async () => {
    expect(await getArtistBySlug('king_triumph')).toBeNull();
    expect(await getArtistBySlug('king%')).toBeNull();
    expect(artistQueries).toHaveLength(0);
  });
});
