// A URL guessed from an artist's name resolves to that artist when exactly one matches.
//
// Search Console reported /a/impulse-nine as a soft 404 on 2026-11-12: Impulse Nine is stored as
// `impulsenine` (their Bandcamp account), and the Mac app and extension built `/a/<slugified
// name>` for a now-playing notification. 243 of 8,001 artists had a slug that differs from their
// name-derived one then. See api/shared/guessed-slug.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nameGuessPattern, pickArtistForGuessedSlug } from '../../shared/guessed-slug';

describe('nameGuessPattern', () => {
  it('joins the words with % and anchors both ends', () => {
    expect(nameGuessPattern('impulse-nine')).toBe('impulse%nine');
    expect(nameGuessPattern('kid-lightbulbs')).toBe('kid%lightbulbs');
    expect(nameGuessPattern('impulsenine')).toBe('impulsenine');
  });

  it('lowercases, as slugs are stored lowercase', () => {
    expect(nameGuessPattern('Impulse-Nine')).toBe('impulse%nine');
  });

  it('refuses anything that cannot be a slug, so nothing reaches the filter unescaped', () => {
    for (const bad of ['', '-', 'a--b', '-a', 'a-', 'a%b', 'a_b', "a'b", 'a,b', 'a.b', 'a b', 'björk']) {
      expect(nameGuessPattern(bad)).toBeNull();
    }
  });
});

describe('pickArtistForGuessedSlug', () => {
  it('finds the artist whose name slugifies to the guess', () => {
    expect(pickArtistForGuessedSlug('impulse-nine', [{ slug: 'impulsenine', name: 'Impulse Nine' }])).toBe('impulsenine');
  });

  it('accepts the naive slugification older clients use, as well as ours', () => {
    // Ours folds accents (sigur-ros); the extension's drops them (sigur-r-s).
    const rows = [{ slug: 'sigur-ros-official', name: 'Sigur Rós' }];
    expect(pickArtistForGuessedSlug('sigur-ros', rows)).toBe('sigur-ros-official');
    expect(pickArtistForGuessedSlug('sigur-r-s', rows)).toBe('sigur-ros-official');
  });

  it('ignores names the ILIKE pattern caught but that slugify to something else', () => {
    // `impulse%nine` also matches "Impulse Nine Nine" and "Impulse of Nine".
    const rows = [
      { slug: 'impulse-nine-nine', name: 'Impulse Nine Nine' },
      { slug: 'impulse-of-nine', name: 'Impulse of Nine' },
    ];
    expect(pickArtistForGuessedSlug('impulse-nine', rows)).toBeNull();
  });

  it('picks nothing when several artists share the name', () => {
    // Paracosm: three bands, stored apart by Bandcamp account or city.
    const rows = [
      { slug: 'xparacosm', name: 'Paracosm' },
      { slug: 'paracosm-orlando', name: 'Paracosm' },
    ];
    expect(pickArtistForGuessedSlug('paracosm', rows)).toBeNull();
  });

  it('counts one artist once, however many spellings match', () => {
    expect(pickArtistForGuessedSlug('impulse-nine', [
      { slug: 'impulsenine', name: 'Impulse Nine' },
      { slug: 'impulsenine', name: 'Impulse Nine' },
    ])).toBe('impulsenine');
  });

  it('skips rows with no name', () => {
    expect(pickArtistForGuessedSlug('impulse-nine', [{ slug: 'x', name: null }])).toBeNull();
  });
});

// resolveArtistSlugAlias: the alias table first, then the name guess, and an error is an outage.

interface Row { [k: string]: unknown }
const tables: Record<string, Row[]> = {};
const failTables = new Set<string>();
const queried: string[] = [];

function makeClient() {
  return {
    from(table: string) {
      queried.push(table);
      let ilike: RegExp | null = null;
      let eq: { column: string; value: unknown } | null = null;
      const rows = () => (tables[table] ?? [])
        .filter(r => !eq || r[eq.column] === eq.value)
        .filter(r => !ilike || ilike.test(String(r.name)));
      const result = () => failTables.has(table)
        ? { data: null, error: { message: 'boom' } }
        : { data: rows(), error: null };
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(column: string, value: unknown) { eq = { column, value }; return builder; },
        ilike(_column: string, pattern: string) {
          ilike = new RegExp(`^${pattern.split('%').join('.*')}$`, 'i');
          return builder;
        },
        limit() { return builder; },
        maybeSingle() {
          const r = result();
          return Promise.resolve({ data: r.data ? r.data[0] ?? null : null, error: r.error });
        },
        then(res: (v: unknown) => unknown) { return Promise.resolve(result()).then(res); },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
vi.mock('../request-catalog', () => ({ requestArtistCatalog: async () => true }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { resolveArtistSlugAlias } = await import('../db');

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  failTables.clear();
  queried.length = 0;
});

describe('resolveArtistSlugAlias — guessed slugs', () => {
  it('resolves a slug guessed from the name to the stored artist', async () => {
    tables.artists = [{ slug: 'impulsenine', name: 'Impulse Nine' }];
    expect(await resolveArtistSlugAlias('impulse-nine')).toEqual({ canonical: 'impulsenine', failed: false });
  });

  it('prefers a recorded alias and does not guess', async () => {
    tables.artist_slug_aliases = [{ alias: 'trentem-ller', artists: { slug: 'trentemoller' } }];
    expect(await resolveArtistSlugAlias('trentem-ller')).toEqual({ canonical: 'trentemoller', failed: false });
    expect(queried).toEqual(['artist_slug_aliases']);
  });

  it('is a clean miss when nothing matches', async () => {
    tables.artists = [{ slug: 'impulsenine', name: 'Impulse Nine' }];
    expect(await resolveArtistSlugAlias('someone-else')).toEqual({ canonical: null, failed: false });
  });

  it('is a clean miss when the name is shared', async () => {
    tables.artists = [{ slug: 'xparacosm', name: 'Paracosm' }, { slug: 'paracosm-orlando', name: 'Paracosm' }];
    expect(await resolveArtistSlugAlias('paracosm')).toEqual({ canonical: null, failed: false });
  });

  it('reports a failed guess lookup as an outage, never as "no such artist"', async () => {
    failTables.add('artists');
    expect(await resolveArtistSlugAlias('impulse-nine')).toEqual({ canonical: null, failed: true });
  });
});
