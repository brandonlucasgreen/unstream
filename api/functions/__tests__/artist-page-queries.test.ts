// The two reads behind /api/artist-page. Both used to cost more round trips than they needed:
// getArtistProfileBySlug was the artist row, then its profile and links (two trips in a row), and
// the releases could only be read after it, by the row's id. Now the bundle is one embedded query,
// and the releases can be found by slug so they run alongside it. These pin the query shapes, and
// that the results come back exactly as callers (artist-page, social-card) have always read them.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Call {
  table: string;
  select?: string;
  count?: string;
  eq: [string, unknown][];
  order: [string, Record<string, unknown> | undefined][];
  limit?: number;
}

const calls: Call[] = [];
let respond: (call: Call) => { data: unknown; error: unknown; count?: number | null };

function makeClient() {
  return {
    from(table: string) {
      const call: Call = { table, eq: [], order: [] };
      calls.push(call);
      const result = () => Promise.resolve(respond(call));
      const builder: Record<string, unknown> = {
        select(cols: string, opts?: { count?: string }) { call.select = cols; call.count = opts?.count; return builder; },
        eq(column: string, value: unknown) { call.eq.push([column, value]); return builder; },
        order(column: string, opts?: Record<string, unknown>) { call.order.push([column, opts]); return builder; },
        limit(n: number) { call.limit = n; return builder; },
        maybeSingle: result,
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return result().then(res, rej); },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
vi.mock('../request-catalog', () => ({ requestArtistCatalog: async () => true }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { getArtistProfileBySlug, getArtistReleases, getArtistReleasesBySlug } = await import('../db');

const ROW = {
  id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', image_url: null, match_confidence: 'claimed',
  source: 'auto', updated_at: '2026-10-01T00:00:00Z', last_enriched_at: null, city: null, country: null, country_code: null,
};
const PROFILE = {
  bio: 'Baltimore, MD', custom_image_url: null, featured_embed: null, verified_at: '2026-09-01T00:00:00Z',
  link_dividers: null, section_order: null,
};
const LINKS = [
  { id: 'l1', artist_id: 'a1', platform: 'mirlo', url: 'https://mirlo.space/kidlightbulbs', display_name: null, source: 'claimed', is_direct: true, latest_release: null, display_order: 0 },
];

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ data: null, error: null });
});

describe('getArtistProfileBySlug', () => {
  it('reads the artist, profile and links in one query', async () => {
    respond = () => ({ data: { ...ROW, artist_profiles: PROFILE, artist_links: LINKS }, error: null });

    const { bundle, failed } = await getArtistProfileBySlug('kid-lightbulbs');

    expect(failed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('artists');
    expect(calls[0].select).toContain('artist_profiles (');
    expect(calls[0].select).toContain('artist_links ( * )');
    expect(calls[0].eq).toEqual([['slug', 'kid-lightbulbs']]);
    // Links keep the artist's order, unpositioned links last — the order the page renders.
    expect(calls[0].order).toEqual([
      ['display_order', { referencedTable: 'artist_links', ascending: true, nullsFirst: false }],
    ]);
    // The same three pieces callers have always read, with the embeds split off the row.
    expect(bundle).toEqual({ artist: ROW, profile: PROFILE, links: LINKS });
  });

  it('gives an unclaimed artist with no profile row a null profile', async () => {
    respond = () => ({ data: { ...ROW, artist_profiles: null, artist_links: LINKS }, error: null });

    const { bundle } = await getArtistProfileBySlug('kid-lightbulbs');

    expect(bundle?.profile).toBeNull();
    expect(bundle?.links).toEqual(LINKS);
  });

  it('tells "no such artist" apart from "the database did not answer"', async () => {
    respond = () => ({ data: null, error: null });
    expect(await getArtistProfileBySlug('nobody')).toEqual({ bundle: null, failed: false });

    respond = () => ({ data: null, error: { message: 'timeout' } });
    expect(await getArtistProfileBySlug('nobody')).toEqual({ bundle: null, failed: true });
  });
});

describe('getArtistReleasesBySlug', () => {
  const releaseRow = {
    slug: 'infinite-normal', title: 'Infinite Normal', release_type: 'album', release_date: '2024-05-01',
    date_precision: 'day', status: 'released', artwork_url: null,
    release_sources: [{ platform: 'bandcamp', release_offers: [{ price: 8, currency: 'USD', availability: 'available' }] }],
    artists: { slug: 'kid-lightbulbs' },
  };

  it('filters by the artist\'s slug through an inner join, with the same order, limit and count', async () => {
    respond = () => ({ data: [releaseRow], error: null, count: 12 });

    const bySlug = await getArtistReleasesBySlug('kid-lightbulbs', 60);
    const bySlugCall = calls[0];
    calls.length = 0;
    const byId = await getArtistReleases('a1', 60);
    const byIdCall = calls[0];

    expect(bySlugCall.select).toContain('artists!inner ( slug )');
    expect(bySlugCall.eq).toEqual([['artists.slug', 'kid-lightbulbs'], ['is_hidden', false]]);
    expect(byIdCall.eq).toEqual([['artist_id', 'a1'], ['is_hidden', false]]);
    for (const c of [bySlugCall, byIdCall]) {
      expect(c.table).toBe('releases');
      expect(c.count).toBe('exact');
      expect(c.limit).toBe(60);
      expect(c.order.map(([col]) => col)).toEqual(['display_order', 'release_date', 'created_at']);
    }
    // The joined slug is a filter, not a field: both reads return the same thing.
    expect(bySlug).toEqual(byId);
    expect(bySlug.total).toBe(12);
    expect(bySlug.releases[0]).not.toHaveProperty('artists');
  });

  it('returns nothing, rather than throwing, when the read fails', async () => {
    respond = () => ({ data: null, error: { message: 'timeout' } });
    expect(await getArtistReleasesBySlug('kid-lightbulbs', 60)).toEqual({ releases: [], total: 0 });
  });
});
