// Which stored links getArtistForCatalog hands the crawler.
//
// This is the other half of the pool decision made in recatalog-sweep-selection.test.ts, and the
// two must agree: getStaleCatalogCandidates decides who is worth a run, catalogArtist decides
// what to fetch for them. If one counts a link the other refuses, the sweep spends its batch on
// artists it then records as failures — which is precisely the loop this pair of checks closes.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// recatalog-sweep-selection.test.ts, so the real query body runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tables: Record<string, Record<string, unknown>[]> = {
  artists: [],
  artist_links: [],
};

function makeClient() {
  return {
    from(table: string) {
      return {
        select(_columns: string) {
          const filters: { column: string; value: unknown }[] = [];
          let wantedPlatforms: string[] | null = null;

          const rows = () => {
            let out = tables[table] ?? [];
            for (const f of filters) out = out.filter(r => r[f.column] === f.value);
            if (wantedPlatforms) {
              const wanted = new Set(wantedPlatforms);
              out = out.filter(r => wanted.has(r.platform as string));
            }
            return out;
          };

          const builder = {
            eq(column: string, value: unknown) {
              filters.push({ column, value });
              return builder;
            },
            in(_column: string, value: string[]) {
              wantedPlatforms = value;
              return builder;
            },
            maybeSingle() {
              return Promise.resolve({ data: rows()[0] ?? null, error: null });
            },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
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

const { getArtistForCatalog } = await import('../db');

const ARTIST_ID = 'artist-1';

function link(platform: string, url: string) {
  return { artist_id: ARTIST_ID, platform, url };
}

beforeEach(() => {
  tables.artists = [{ id: ARTIST_ID, name: 'Warren Harrison' }];
  tables.artist_links = [];
});

describe('getArtistForCatalog', () => {
  it('returns a real Bandcamp artist page', async () => {
    tables.artist_links = [link('bandcamp', 'https://warrenharrison.bandcamp.com')];

    const artist = await getArtistForCatalog(ARTIST_ID);

    expect(artist?.bandcampUrl).toBe('https://warrenharrison.bandcamp.com');
  });

  it('refuses a bandcamp.com/search placeholder', async () => {
    // The placeholder search-utils writes when nothing resolved a real page. bandcampMusicUrl
    // reduces it to https://bandcamp.com/music, which 404s every single time — so handing it to
    // the crawler can only ever produce a failure and a longer backoff.
    tables.artist_links = [link('bandcamp', 'https://bandcamp.com/search?q=Warren%20Harrison')];

    const artist = await getArtistForCatalog(ARTIST_ID);

    // Not the string, and not a truthy fallback: catalogArtist branches on this being null.
    expect(artist?.bandcampUrl).toBeNull();
  });

  it('leaves the other platforms alone when the Bandcamp link is a placeholder', async () => {
    // 116 of the 189 placeholder rows measured on 2026-08-03 sat alongside a real Discogs,
    // Faircamp or jam.coop link. Dropping those artists would lose catalogues we can build.
    tables.artist_links = [
      link('bandcamp', 'https://bandcamp.com/search?q=bgm'),
      link('discogs', 'https://www.discogs.com/artist/4861285'),
      link('faircamp', 'https://fromabasement.com/faircamp'),
      link('jamcoop', 'https://jam.coop/artists/melondruie'),
      link('officialsite', 'https://example.com'),
    ];

    const artist = await getArtistForCatalog(ARTIST_ID);

    expect(artist?.bandcampUrl).toBeNull();
    expect(artist?.discogsUrl).toBe('https://www.discogs.com/artist/4861285');
    expect(artist?.faircampUrl).toBe('https://fromabasement.com/faircamp');
    expect(artist?.jamcoopUrl).toBe('https://jam.coop/artists/melondruie');
    expect(artist?.officialSiteUrl).toBe('https://example.com');
  });

  it('leaves an artist with nothing but a placeholder with no crawlable link at all', async () => {
    // 73 of the 189 were in the pool *only* because of the placeholder. With every URL null,
    // catalogArtist takes its "no bandcamp, discogs, faircamp, or jam.coop link stored" branch
    // instead of throwing a 404 — the same outcome it would reach if the row weren't there.
    tables.artist_links = [link('bandcamp', 'https://bandcamp.com/search?q=Darkitecture')];

    const artist = await getArtistForCatalog(ARTIST_ID);

    expect(artist).not.toBeNull();
    expect(artist?.bandcampUrl).toBeNull();
    expect(artist?.discogsUrl).toBeNull();
    expect(artist?.faircampUrl).toBeNull();
    expect(artist?.jamcoopUrl).toBeNull();
  });

  it.each([
    ['a bare artist subdomain', 'https://melondruie.bandcamp.com'],
    ['an album-depth page', 'https://warrenharrison.bandcamp.com/album/some-record'],
    ['a /music page', 'https://nixienoise.bandcamp.com/music'],
    ['a Bandcamp Pro custom domain', 'https://music.sufjan.com'],
  ])('keeps %s', async (_label, url) => {
    // Only the search URL is a placeholder. Every other shape is a real page, and
    // bandcampMusicUrl strips it back to origin + /music.
    tables.artist_links = [link('bandcamp', url)];

    const artist = await getArtistForCatalog(ARTIST_ID);

    expect(artist?.bandcampUrl).toBe(url);
  });
});
