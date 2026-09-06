// persistEnrichment used to write on every Phase 2 call whether or not anything had changed: one
// upsert per enrichment link, sequentially, then an unconditional update of the `artists` row to
// stamp `last_enriched_at` — a column nothing reads. It ran after the Redis cache read, so a cache
// hit still wrote, and every one of those writes was a new tuple version, fresh index entries
// (six on `artists`, one a GIN trigram index), WAL, and a dead tuple for autovacuum.
//
// These tests pin the fix: read the stored links once, write only the platforms whose URL differs,
// write location only when it differs, and never touch the artist row otherwise.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
/** Every write the code attempted, by kind, so a skipped write is observable. */
const writes: { table: string; op: 'upsert' | 'update'; rows: Row[] }[] = [];
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
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        upsert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          writes.push({ table, op: 'upsert', rows: list });
          for (const r of list) {
            const i = rowsOf().findIndex(e => e.platform === r.platform && e.artist_id === r.artist_id);
            if (i >= 0) rowsOf()[i] = { ...rowsOf()[i], ...r };
            else rowsOf().push({ id: `${table}-${rowsOf().length + 1}`, ...r });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Row) {
          writes.push({ table, op: 'update', rows: [patch] });
          return {
            eq: () => Promise.resolve({ data: null, error: null }),
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

const { persistEnrichment } = await import('../db');

const OFFICIAL = 'https://bigthief.net';
const DISCOGS = 'https://www.discogs.com/artist/5089281-Big-Thief';
const INSTAGRAM = 'https://www.instagram.com/bigthiefmusic';

function mbData(overrides: Partial<Parameters<typeof persistEnrichment>[1]> = {}) {
  return {
    officialUrl: OFFICIAL,
    discogsUrl: DISCOGS,
    hasPre2005Release: false,
    socialLinks: [{ platform: 'instagram', url: INSTAGRAM }],
    ...overrides,
  };
}

function seedArtist(overrides: Row = {}) {
  tables.artists = [{
    id: 'a1',
    slug: 'big-thief',
    name: 'Big Thief',
    match_confidence: 'verified',
    city: null,
    country: null,
    country_code: null,
    ...overrides,
  }];
}

function seedLinks(links: { platform: string; url: string; source?: string }[]) {
  tables.artist_links = links.map((l, i) => ({
    id: `l${i}`,
    artist_id: 'a1',
    platform: l.platform,
    url: l.url,
    source: l.source ?? 'musicbrainz',
    is_direct: true,
  }));
}

const writesTo = (table: string) => writes.filter(w => w.table === table);

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
  linkReadError.value = null;
});

describe('an artist whose enrichment links are already stored', () => {
  it('writes nothing at all', async () => {
    seedArtist();
    seedLinks([
      { platform: 'officialsite', url: OFFICIAL },
      { platform: 'discogs', url: DISCOGS },
      { platform: 'instagram', url: INSTAGRAM },
    ]);

    await persistEnrichment('Big Thief', mbData());

    expect(writes).toEqual([]);
  });

  it('leaves a matching URL alone even when a different pipeline wrote it', async () => {
    // `source` is provenance, not data. Comparing it would make search and enrichment flip the
    // same row back and forth on alternate requests forever.
    seedArtist();
    seedLinks([
      { platform: 'officialsite', url: OFFICIAL, source: 'search' },
      { platform: 'discogs', url: DISCOGS, source: 'search' },
      { platform: 'instagram', url: INSTAGRAM, source: 'search' },
    ]);

    await persistEnrichment('Big Thief', mbData());

    expect(writesTo('artist_links')).toEqual([]);
  });

  it('never stamps the artist row just to say enrichment ran', async () => {
    seedArtist();
    seedLinks([
      { platform: 'officialsite', url: OFFICIAL },
      { platform: 'discogs', url: DISCOGS },
      { platform: 'instagram', url: INSTAGRAM },
    ]);

    await persistEnrichment('Big Thief', mbData());

    expect(writesTo('artists')).toEqual([]);
  });
});

describe('when something has actually changed', () => {
  it('writes only the platforms whose URL differs, in one upsert', async () => {
    seedArtist();
    seedLinks([
      { platform: 'officialsite', url: 'https://old-site.example' },
      { platform: 'discogs', url: DISCOGS },
    ]);

    await persistEnrichment('Big Thief', mbData());

    const linkWrites = writesTo('artist_links');
    expect(linkWrites).toHaveLength(1);
    expect(linkWrites[0].op).toBe('upsert');
    expect(linkWrites[0].rows.map(r => r.platform).sort()).toEqual(['instagram', 'officialsite']);
    expect(linkWrites[0].rows.every(r => r.source === 'musicbrainz' && r.is_direct === true)).toBe(true);
  });

  it('writes location only when it differs from what is stored', async () => {
    seedArtist({ city: 'Brooklyn', country: 'United States', country_code: 'US' });
    seedLinks([
      { platform: 'officialsite', url: OFFICIAL },
      { platform: 'discogs', url: DISCOGS },
      { platform: 'instagram', url: INSTAGRAM },
    ]);

    await persistEnrichment('Big Thief', mbData({
      location: { city: 'Brooklyn', country: 'United States', countryCode: 'US' },
    }));
    expect(writesTo('artists')).toEqual([]);

    await persistEnrichment('Big Thief', mbData({
      location: { city: 'Los Angeles', country: 'United States', countryCode: 'US' },
    }));
    expect(writesTo('artists')).toEqual([
      { table: 'artists', op: 'update', rows: [{ city: 'Los Angeles', country: 'United States', country_code: 'US' }] },
    ]);
  });
});

describe('guards', () => {
  it('writes every link when the comparison read fails — an extra write beats a missing link', async () => {
    seedArtist();
    seedLinks([{ platform: 'officialsite', url: OFFICIAL }]);
    linkReadError.value = 'connection reset';

    await persistEnrichment('Big Thief', mbData());

    const linkWrites = writesTo('artist_links');
    expect(linkWrites).toHaveLength(1);
    expect(linkWrites[0].rows.map(r => r.platform).sort()).toEqual(['discogs', 'instagram', 'officialsite']);
  });

  it('never touches a claimed artist', async () => {
    seedArtist({ match_confidence: 'claimed' });
    seedLinks([]);

    await persistEnrichment('Big Thief', mbData({ location: { city: 'X' } }));

    expect(writes).toEqual([]);
  });

  it('does nothing for an artist search has never persisted', async () => {
    tables.artists = [];

    await persistEnrichment('Nobody Here', mbData());

    expect(writes).toEqual([]);
  });
});
