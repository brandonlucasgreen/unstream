// Stop a second artist row being created when a different source spells the name differently.
//
// `artistSlug` derives the slug from whichever name won aggregation, and that varies between
// searches with which platforms answered — so "Big Thief" and "Bigthief" became two rows, two pages
// and two half-populated link sets. 13 of the 27 duplicate pairs on production arose this way, and
// unlike the machine-key cause they were still arriving.
//
// The fix matches on a shared *identity* URL. What makes it safe is the platforms it excludes:
// measured on production, `Honeycrush`/`Honey Crush` share `patreon.com/honeycrush` and
// `Boto`/`Błoto` share `facebook.com/blotoquartet` — links mis-attached by the homonym bug fixed in
// July. Treating those as evidence would re-fuse two genuinely different bands. Every one of those
// cases is pinned below; if a future change adds socials to IDENTITY_PLATFORMS, these fail.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
const queries: { table: string; platforms?: unknown; or?: string }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      let inFilter: [string, unknown[]] | null = null;
      let orFilter: string | null = null;

      const rowsOf = () => (tables[table] ??= []);
      const matched = () =>
        rowsOf().filter(r => {
          if (!eqs.every(([c, v]) => r[c] === v)) return false;
          if (inFilter && !inFilter[1].includes(r[inFilter[0]])) return false;
          if (orFilter) {
            // Mirror PostgREST `url.ilike.%needle%` — the only or() shape used here.
            const needles = orFilter.split(',').map(c => c.replace(/^url\.ilike\.%|%$/g, '').replace(/\\(.)/g, '$1'));
            if (!needles.some(n => String(r.url ?? '').toLowerCase().includes(n.toLowerCase()))) return false;
          }
          return true;
        });

      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return builder; },
        in(c: string, v: unknown[]) { inFilter = [c, v]; return builder; },
        or(f: string) { orFilter = f; queries.push({ table, platforms: inFilter?.[1], or: f }); return builder; },
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        maybeSingle() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        upsert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          for (const r of list) rowsOf().push(r);
          return { select: () => ({ single: () => Promise.resolve({ data: list[0], error: null }) }),
                   then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res) };
        },
        then(res: (v: unknown) => unknown) {
          // Embedded `artists!inner(slug)` — resolve it from the artists table by artist_id.
          const rows = matched().map(r => ({
            ...r,
            artists: tables.artists?.find(a => a.id === r.artist_id) ?? null,
          }));
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

const { persistSearchResults, artistSlug } = await import('../db');

/** A search result shaped as persistSearchResults expects. */
function result(name: string, platforms: { sourceId: string; url: string }[]) {
  return {
    id: `r-${name}`,
    name,
    type: 'artist' as const,
    platforms,
    matchConfidence: 'verified' as const,
  };
}

function existingArtist(id: string, name: string, links: { sourceId: string; url: string }[], confidence = 'unverified') {
  tables.artists.push({ id, slug: artistSlug(name), name, match_confidence: confidence });
  for (const l of links) tables.artist_links.push({ artist_id: id, platform: l.sourceId, url: l.url });
}

/**
 * The distinct artist slugs in the table — i.e. how many artist rows exist.
 *
 * Deduped because this fake's `upsert` appends rather than merging on conflict, while the real table
 * has `unique(slug)`. Two entries with the same slug therefore mean one row, and what these tests are
 * actually about is whether a *second* row appears.
 */
const slugs = () => [...new Set((tables.artists as { slug: string }[]).map(a => a.slug))].sort();

beforeEach(() => {
  queries.length = 0;
  tables.artists = [];
  tables.artist_links = [];
  tables.artist_profiles = [];
});

describe('persistSearchResults — reuses an artist stored under a different spelling', () => {
  it('does not create a second row when a Bandcamp URL is already held', async () => {
    existingArtist('a1', 'Big Thief', [{ sourceId: 'bandcamp', url: 'https://bigthief.bandcamp.com' }]);

    // A later search where a different source won the name.
    await persistSearchResults([
      result('Bigthief', [{ sourceId: 'bandcamp', url: 'https://bigthief.bandcamp.com' }]),
    ] as never);

    expect(slugs()).toEqual(['big-thief']);
  });

  it('matches through a trailing slash', async () => {
    // Measured: 581 of 4,782 stored identity links carry a trailing slash, so exact matching would
    // miss a large share. The prefilter strips it.
    existingArtist('a1', 'Rue Oberkampf', [{ sourceId: 'bandcamp', url: 'https://rueoberkampf.bandcamp.com/' }]);

    await persistSearchResults([
      result('Rueoberkampf', [{ sourceId: 'bandcamp', url: 'https://rueoberkampf.bandcamp.com' }]),
    ] as never);

    expect(slugs()).toEqual(['rue-oberkampf']);
  });

  it('matches through www. and http', async () => {
    // 2,804 stored identity links carry www.
    existingArtist('a1', 'Creepy Nuts', [{ sourceId: 'discogs', url: 'http://www.discogs.com/artist/3939097' }]);

    await persistSearchResults([
      result('Creepynuts', [{ sourceId: 'discogs', url: 'https://discogs.com/artist/3939097' }]),
    ] as never);

    expect(slugs()).toEqual(['creepy-nuts']);
  });

  it('still creates a row for a genuinely new artist', async () => {
    await persistSearchResults([
      result('Someone New', [{ sourceId: 'bandcamp', url: 'https://someonenew.bandcamp.com' }]),
    ] as never);

    expect(slugs()).toEqual(['someone-new']);
  });
});

describe('persistSearchResults — must NOT fuse different artists', () => {
  it('keeps Honeycrush and Honey Crush apart despite a shared Patreon', async () => {
    // The Brooklyn and Orlando bands. Their shared patreon.com/honeycrush is mis-attached data from
    // the bug fixed in July; treating it as evidence would undo that fix.
    existingArtist('a1', 'Honey Crush', [
      { sourceId: 'bandcamp', url: 'https://honeycrush.bandcamp.com' },
      { sourceId: 'patreon', url: 'https://patreon.com/honeycrush' },
    ]);

    await persistSearchResults([
      result('Honeycrush', [
        { sourceId: 'bandcamp', url: 'https://honeycrushing.bandcamp.com' },
        { sourceId: 'patreon', url: 'https://patreon.com/honeycrush' },
      ]),
    ] as never);

    expect(slugs()).toEqual(['honey-crush', 'honeycrush']);
  });

  it('keeps Boto and Błoto apart despite a shared Facebook', async () => {
    existingArtist('a1', 'Boto', [{ sourceId: 'facebook', url: 'https://facebook.com/blotoquartet' }]);

    await persistSearchResults([
      result('Błoto', [{ sourceId: 'facebook', url: 'https://facebook.com/blotoquartet' }]),
    ] as never);

    expect(slugs()).toEqual(['bloto', 'boto']);
  });

  it('keeps Tiger Cub and Tigercub apart — they share nothing', async () => {
    existingArtist('a1', 'Tigercub', [{ sourceId: 'bandcamp', url: 'https://tigercub.bandcamp.com' }]);

    await persistSearchResults([
      result('Tiger Cub', [{ sourceId: 'bandcamp', url: 'https://tigercubband.bandcamp.com' }]),
    ] as never);

    expect(slugs()).toEqual(['tiger-cub', 'tigercub']);
  });

  it('does not match a URL that is merely a prefix of another', async () => {
    // The prefilter is a substring match, so discogs.com/artist/123 would otherwise hit
    // discogs.com/artist/1234. The normalized re-check is what stops it.
    existingArtist('a1', 'Artist Twelve Thirty Four', [
      { sourceId: 'discogs', url: 'https://www.discogs.com/artist/1234' },
    ]);

    await persistSearchResults([
      result('Someone Else', [{ sourceId: 'discogs', url: 'https://www.discogs.com/artist/123' }]),
    ] as never);

    expect(slugs()).toEqual(['artist-twelve-thirty-four', 'someone-else']);
  });

  it('refuses to guess when two artists both hold the URL', async () => {
    // Already-broken data. Picking one would attach this result to a coin flip.
    existingArtist('a1', 'First Claimant', [{ sourceId: 'bandcamp', url: 'https://shared.bandcamp.com' }]);
    existingArtist('a2', 'Second Claimant', [{ sourceId: 'bandcamp', url: 'https://shared.bandcamp.com' }]);

    await persistSearchResults([
      result('Third Spelling', [{ sourceId: 'bandcamp', url: 'https://shared.bandcamp.com' }]),
    ] as never);

    expect(slugs()).toContain('third-spelling');
  });
});

describe('persistSearchResults — the identity lookup is scoped and cheap', () => {
  it('only queries identity platforms, never socials', async () => {
    existingArtist('a1', 'Someone', [{ sourceId: 'bandcamp', url: 'https://someone.bandcamp.com' }]);

    await persistSearchResults([
      result('Someone Different', [
        { sourceId: 'instagram', url: 'https://instagram.com/x' },
        { sourceId: 'facebook', url: 'https://facebook.com/x' },
        { sourceId: 'bandcamp', url: 'https://other.bandcamp.com' },
      ]),
    ] as never);

    const q = queries.find(x => x.table === 'artist_links');
    expect(q).toBeDefined();
    const platforms = q!.platforms as string[];
    expect(platforms).toContain('bandcamp');
    expect(platforms).not.toContain('instagram');
    expect(platforms).not.toContain('facebook');
    expect(platforms).not.toContain('patreon');
    // Only the bandcamp URL should be in the or() filter.
    expect(q!.or).toContain('other.bandcamp.com');
    expect(q!.or).not.toContain('instagram');
  });

  it('does not run the lookup at all when the artist already has a row', async () => {
    // persistSearchResults is awaited before the search response is sent, so a known artist must not
    // pay for an extra round trip.
    existingArtist('a1', 'Known Artist', [{ sourceId: 'bandcamp', url: 'https://known.bandcamp.com' }]);

    await persistSearchResults([
      result('Known Artist', [{ sourceId: 'bandcamp', url: 'https://known.bandcamp.com' }]),
    ] as never);

    expect(queries.filter(q => q.table === 'artist_links')).toHaveLength(0);
  });

  it('skips the lookup when the result has no identity platform at all', async () => {
    await persistSearchResults([
      result('Socials Only', [
        { sourceId: 'instagram', url: 'https://instagram.com/y' },
        { sourceId: 'officialsite', url: 'https://example.test' },
      ]),
    ] as never);

    expect(queries.filter(q => q.table === 'artist_links')).toHaveLength(0);
    expect(slugs()).toEqual(['socials-only']);
  });
});

describe('persistSearchResults — the claimed guard follows the match', () => {
  it('does not overwrite a claimed row reached via an identity URL', async () => {
    // The guard checks the slug it is about to write. Redirecting to another row without re-checking
    // would let a stranger's search overwrite a claimed profile — the exact thing the guard exists
    // for, bypassed by the new path.
    existingArtist('a1', 'Kid Lightbulbs',
      [{ sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' }], 'claimed');

    await persistSearchResults([
      result('kidlightbulbs', [{ sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' }]),
    ] as never);

    // No new row, and no upsert against the claimed one.
    expect(slugs()).toEqual(['kid-lightbulbs']);
    expect((tables.artists as { name: string }[]).map(a => a.name)).toEqual(['Kid Lightbulbs']);
  });
});
