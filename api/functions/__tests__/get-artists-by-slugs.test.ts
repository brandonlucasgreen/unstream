// getArtistsBySlugs exists for the read bill: the name-contains search channel resolves up to
// six known artists per fuzzy search, and per-slug getArtistBySlug calls cost 2-3 queries each —
// 12-18 uncached reads inside every search. The batch must answer the whole list in at most
// three queries and produce cards identical to the single-slug path (both feed the same
// artistRowToResult), which is what these pin.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
const queries: { table: string; op: string }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const filters: { column: string; values: unknown[] }[] = [];
      const builder: Record<string, unknown> = {
        select() { return builder; },
        order() { return builder; },
        eq(column: string, value: unknown) { filters.push({ column, values: [value] }); return builder; },
        in(column: string, values: unknown[]) {
          queries.push({ table, op: 'in' });
          filters.push({ column, values });
          return builder;
        },
        or() { return builder; },
        single() { return builder.then as never; },
        then(res: (v: unknown) => unknown) {
          const rows = (tables[table] ?? []).filter(r =>
            filters.every(f => f.values.includes(r[f.column]))
          );
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

const { getArtistsBySlugs } = await import('../db');

const now = () => new Date().toISOString();

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  queries.length = 0;

  tables.artists = [
    {
      id: 'a1', slug: 'king-triumph', name: 'King Triumph', image_url: 'https://img/kt.jpg',
      match_confidence: 'verified', source: 'auto', updated_at: now(), last_enriched_at: null,
      city: 'Baltimore', country: 'United States', country_code: 'US',
    },
    {
      id: 'a2', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', image_url: null,
      match_confidence: 'claimed', source: 'auto', updated_at: now(), last_enriched_at: null,
      city: null, country: null, country_code: null,
    },
  ];
  tables.artist_links = [
    { id: 'l1', artist_id: 'a1', platform: 'bandcamp', url: 'https://kingtriumph.bandcamp.com', display_name: null, source: 'search', is_direct: true, latest_release: null, display_order: 0 },
    { id: 'l2', artist_id: 'a2', platform: 'mirlo', url: 'https://mirlo.space/kidlightbulbs', display_name: null, source: 'claimed', is_direct: true, latest_release: null, display_order: 0 },
  ];
  tables.artist_profiles = [
    { artist_id: 'a2', bio: 'Baltimore, MD', custom_image_url: 'https://img/custom.jpg', website_url: null, featured_embed: null, verified_at: now(), link_dividers: null },
  ];
});

describe('getArtistsBySlugs', () => {
  it('answers every slug with its links and profile in three batched queries', async () => {
    const results = await getArtistsBySlugs(['king-triumph', 'kid-lightbulbs', 'nobody-here']);

    expect(results.size).toBe(2);
    expect(queries.map(q => q.table)).toEqual(['artists', 'artist_links', 'artist_profiles']);

    const kt = results.get('king-triumph')!;
    expect(kt.platforms).toEqual([
      { sourceId: 'bandcamp', url: 'https://kingtriumph.bandcamp.com' },
    ]);
    expect(kt.location).toEqual({ city: 'Baltimore', country: 'United States', countryCode: 'US' });

    const kl = results.get('kid-lightbulbs')!;
    expect(kl.matchConfidence).toBe('claimed');
    // The claimed card carries its profile — the custom image wins, matching getArtistBySlug.
    expect(kl.profile).toMatchObject({ bio: 'Baltimore, MD', verified: true });
    expect(kl.imageUrl).toBe('https://img/custom.jpg');
  });

  it('skips the profiles query entirely when no slug is claimed', async () => {
    await getArtistsBySlugs(['king-triumph']);

    expect(queries.map(q => q.table)).toEqual(['artists', 'artist_links']);
  });

  it('drops slugs that could not be stored ones instead of interpolating them', async () => {
    const results = await getArtistsBySlugs(['king-triumph', 'not a slug!', 'slug.ilike.%25']);

    expect(results.size).toBe(1);
    expect(results.has('king-triumph')).toBe(true);
  });

  it('returns an empty map, not a throw, when every slug is unknown', async () => {
    const results = await getArtistsBySlugs(['nobody', 'nobody-else']);
    expect(results.size).toBe(0);
  });
});
