// Which stored links getArtistForCatalog hands the crawler.
//
// This is the other half of the pool decision made in recatalog-sweep-selection.test.ts, and the
// two must agree: getStaleCatalogCandidates decides who is worth a run, catalogArtist decides
// what to fetch for them. If one counts a link the other refuses, the sweep spends its batch on
// artists it then records as failures — which is precisely the loop this pair of checks closes.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// recatalog-sweep-selection.test.ts, so the real query body runs.
//
// The last two blocks cover the artist's photos, which the Bandcamp pass uses to replace a stored
// photo Bandcamp has deleted (artist-photo-refresh.ts), and the guarded write that replaces it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tables: Record<string, Record<string, unknown>[]> = {
  artists: [],
  artist_links: [],
};
/** The columns each table was read with, so a dropped embed fails a test instead of passing on fixtures. */
const selected: Record<string, string> = {};

function makeClient() {
  return {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          const filters: { column: string; value: unknown }[] = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push({ column, value });
              return builder;
            },
            select() {
              const hits = (tables[table] ?? []).filter(r => filters.every(f => r[f.column] === f.value));
              for (const row of hits) Object.assign(row, patch);
              return Promise.resolve({ data: hits.map(r => ({ id: r.id })), error: null });
            },
          };
          return builder;
        },
        select(columns: string) {
          selected[table] = columns;
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

const { getArtistForCatalog, replaceArtistPhoto } = await import('../db');

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

describe("getArtistForCatalog: the artist's photos", () => {
  const STORED = 'https://f4.bcbits.com/img/0042332926_23.jpg';

  it("returns the stored photo and a claimed artist's own, read in the same query", async () => {
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: STORED, artist_profiles: { custom_image_url: 'https://example.com/me.jpg' } }];

    const artist = await getArtistForCatalog(ARTIST_ID);

    expect(selected.artists).toContain('artist_profiles(custom_image_url)');
    expect(artist?.imageUrl).toBe(STORED);
    expect(artist?.customImageUrl).toBe('https://example.com/me.jpg');
  });

  it('has no own photo for an unclaimed artist', async () => {
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: STORED, artist_profiles: null }];

    expect((await getArtistForCatalog(ARTIST_ID))?.customImageUrl).toBeNull();
  });

  it('reads the own photo whichever shape PostgREST embeds the profile in', async () => {
    // One object is what a unique artist_id should give; an array must not lose the artist's photo.
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: STORED, artist_profiles: [{ custom_image_url: 'https://example.com/me.jpg' }] }];

    expect((await getArtistForCatalog(ARTIST_ID))?.customImageUrl).toBe('https://example.com/me.jpg');
  });
});

describe('replaceArtistPhoto', () => {
  const GONE = 'https://f4.bcbits.com/img/0042332926_23.jpg';
  const CURRENT = 'https://f4.bcbits.com/img/0099887766_23.jpg';

  it('replaces the photo the caller found gone', async () => {
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: GONE }];

    expect(await replaceArtistPhoto(ARTIST_ID, GONE, CURRENT)).toBe(true);
    expect(tables.artists[0].image_url).toBe(CURRENT);
  });

  it('leaves a photo that changed since it was checked: a search that stored a newer one wins', async () => {
    const newer = 'https://f4.bcbits.com/img/0055555555_23.jpg';
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: newer }];

    expect(await replaceArtistPhoto(ARTIST_ID, GONE, CURRENT)).toBe(false);
    expect(tables.artists[0].image_url).toBe(newer);
  });

  it("writes nothing but image_url: updated_at means last verified, not changed", async () => {
    const updatedAt = '2026-09-01T00:00:00.000Z';
    tables.artists = [{ id: ARTIST_ID, name: 'Masefield Labs', image_url: GONE, updated_at: updatedAt }];

    await replaceArtistPhoto(ARTIST_ID, GONE, CURRENT);

    expect(tables.artists[0]).toEqual({ id: ARTIST_ID, name: 'Masefield Labs', image_url: CURRENT, updated_at: updatedAt });
  });
});
