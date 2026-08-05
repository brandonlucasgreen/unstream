// Who the scheduled sweep picks, and who it must not.
//
// The selection is the whole feature: get it wrong and the sweep runs every few hours, reports
// success, and refreshes the wrong artists — or none — while the alerts and artist pages it
// exists to keep current quietly go stale. Every rule here is one that would fail silently.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// release-order-query.test.ts, so the real query body runs — including the paging, which is
// the part that silently truncated when it was a plain `.limit()`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter {
  kind: 'eq' | 'not' | 'in' | 'range';
  column?: string;
  value?: unknown;
}

interface Query {
  table: string;
  columns: string;
  filters: Filter[];
}

const queries: Query[] = [];

/** Rows the fake returns, keyed by table. Tests set these. */
const tables: Record<string, Record<string, unknown>[]> = {
  artist_links: [],
  saved_artists: [],
  release_catalog_state: [],
};

/** Set to a table name to make that table's read fail. */
let failingTable: string | null = null;

/** PostgREST caps every response at this many rows regardless of what was asked for. */
const MAX_ROWS = 1000;

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const query: Query = { table, columns, filters: [] };
          queries.push(query);

          const builder = {
            eq(column: string, value: unknown) {
              query.filters.push({ kind: 'eq', column, value });
              return builder;
            },
            not(column: string, operator: string, value: unknown) {
              query.filters.push({ kind: 'not', column, value: `${operator} ${value}` });
              return builder;
            },
            in(column: string, value: unknown) {
              query.filters.push({ kind: 'in', column, value });
              return builder;
            },
            range(from: number, to: number) {
              query.filters.push({ kind: 'range', value: [from, to] });
              return builder;
            },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              if (failingTable === table) {
                return Promise.resolve({ data: null, error: { message: 'connection reset' } })
                  .then(resolve, reject);
              }

              let rows = tables[table] ?? [];
              const inFilter = query.filters.find(f => f.kind === 'in');
              if (inFilter) {
                const wanted = new Set(inFilter.value as string[]);
                rows = rows.filter(r => wanted.has(r[inFilter.column as string] as string));
              }
              const eqFilter = query.filters.find(f => f.kind === 'eq');
              if (eqFilter) {
                rows = rows.filter(r => r[eqFilter.column as string] === eqFilter.value);
              }

              // The behaviour that matters: a page is capped at MAX_ROWS whatever was asked for.
              const rangeFilter = query.filters.find(f => f.kind === 'range');
              if (rangeFilter) {
                const [from, to] = rangeFilter.value as [number, number];
                rows = rows.slice(from, from + Math.min(to - from + 1, MAX_ROWS));
              } else {
                rows = rows.slice(0, MAX_ROWS);
              }

              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
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

const { getStaleCatalogCandidates, RECATALOG_COOLDOWN_HOURS } = await import('../db');

const HOUR = 3600_000;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();

/**
 * Give an artist something to crawl. Without this they aren't in the pool at all.
 *
 * The URL is part of the fixture because the pool now judges shape as well as platform: a
 * `bandcamp.com/search?q=` row is a placeholder, not an artist page. `artist_links.url` is
 * `not null` in the schema, so every row here carries one.
 */
function link(artistId: string | null, platform = 'bandcamp', url?: string) {
  return { artist_id: artistId, platform, url: url ?? `https://${platform}.example/artist` };
}

/** The "go search Bandcamp yourself" placeholder search-utils writes when nothing resolved. */
function searchPlaceholder(artistId: string, name = 'Some Artist') {
  return link(artistId, 'bandcamp', `https://bandcamp.com/search?q=${encodeURIComponent(name)}`);
}

function saved(artistId: string | null) {
  return { artist_id: artistId, deleted: false };
}

function state(
  artistId: string,
  attemptedHoursAgo: number,
  catalogued: { hoursAgo: number; releasesFound?: number } | null = null
) {
  return {
    artist_id: artistId,
    last_attempted_at: ago(attemptedHoursAgo),
    last_catalogued_at: catalogued ? ago(catalogued.hoursAgo) : null,
    releases_found: catalogued?.releasesFound ?? null,
  };
}

beforeEach(() => {
  queries.length = 0;
  tables.artist_links = [];
  tables.saved_artists = [];
  tables.release_catalog_state = [];
  failingTable = null;
});

describe('getStaleCatalogCandidates — who is in the pool', () => {
  it('includes artists nobody has saved', async () => {
    tables.artist_links = [link('searched-only'), link('saved-too')];
    tables.saved_artists = [saved('saved-too')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole point of widening the pool: alerts aren't the only consumer of a catalogue.
    // /a/:slug renders a release list for any catalogued artist, and those pages exist because
    // somebody searched.
    expect(new Set(result.candidates.map(c => c.artistId))).toEqual(
      new Set(['searched-only', 'saved-too'])
    );
    expect(result.catalogueable).toBe(2);
    expect(result.savedArtists).toBe(1);
  });

  it('excludes artists with nothing crawlable', async () => {
    // catalogArtist records an artist with no bandcamp/discogs/faircamp/jamcoop/mirlo link as an
    // *error*, which bumps consecutive_failures and writes last_error. Sweeping them would
    // spend the batch on artists with nothing to fetch and turn the failure counters to noise.
    tables.artist_links = [link('real', 'bandcamp'), link('site-only', 'officialsite')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['real']);
  });

  // This list must stay identical to catalogArtist's "is there anything to fetch" condition in
  // catalog-artist-background.ts. The two disagreeing is the specific failure this pins: a
  // platform the sweep considers crawlable but catalogArtist doesn't gets swept, rejected, and
  // recorded as a failure, poisoning consecutive_failures for an artist who was never at fault.
  it.each(['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'mirlo'])(
    'treats a %s link as crawlable',
    async platform => {
      tables.artist_links = [link('a', platform)];

      const result = await getStaleCatalogCandidates(10);

      expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['a']);
    }
  );

  it('treats a platform outside the catalogueable list as not crawlable', async () => {
    // The negative half of the case above: without it, the it.each only proves the listed
    // platforms are *included*, so a stray addition to CATALOGUEABLE_PLATFORMS would go unnoticed.
    tables.artist_links = [link('a', 'spotify'), link('b', 'ampwall'), link('c', 'subvert')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates).toEqual([]);
  });

  it('excludes an artist whose only Bandcamp link is a search placeholder', async () => {
    // `https://bandcamp.com/search?q=X` is a UI affordance, not an artist page. bandcampMusicUrl
    // reduces any URL to origin + /music, so every one of these derives https://bandcamp.com/music
    // — a hard 404. Measured 2026-08-03: 189 such rows, and the 16 that had been swept were the
    // *only* failures in release_catalog_state, each climbing a backoff it could never escape.
    tables.artist_links = [searchPlaceholder('placeholder-only'), link('real')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['real']);
    expect(result.ok && result.catalogueable).toBe(1);
  });

  it('keeps an artist who has a placeholder Bandcamp link but a real Discogs one', async () => {
    // The placeholder is worthless; the Discogs link is not. Dropping the artist entirely would
    // lose a catalogue we can actually build.
    tables.artist_links = [
      searchPlaceholder('mixed'),
      link('mixed', 'discogs', 'https://www.discogs.com/artist/12345'),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['mixed']);
  });

  it('keeps a real Bandcamp artist page whose path happens to be deep', async () => {
    // Only the search URL is the placeholder. An album-depth link is a perfectly good artist
    // page — bandcampMusicUrl strips it back to the origin.
    tables.artist_links = [link('deep', 'bandcamp', 'https://warrenharrison.bandcamp.com/album/x')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['deep']);
  });

  it('counts an artist once however many platforms they are on', async () => {
    tables.artist_links = [link('a', 'bandcamp'), link('a', 'discogs'), link('a', 'faircamp')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    expect(result.catalogueable).toBe(1);
  });

  it('drops artists still inside the re-catalog cooldown, and counts them', async () => {
    tables.artist_links = [link('fresh'), link('stale')];
    tables.release_catalog_state = [
      state('fresh', 2, { hoursAgo: 2, releasesFound: 12 }),
      state('stale', RECATALOG_COOLDOWN_HOURS + 24, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 24 }),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Spending a bounded batch on artists claimArtistForCatalog will refuse a moment later
    // would make the sweep a no-op that still reports work.
    expect(result.candidates.map(c => c.artistId)).toEqual(['stale']);
    expect(result.inCooldown).toBe(1);
    expect(result.eligible).toBe(1);
    expect(result.catalogueable).toBe(2);
  });

  it('keeps an artist who has only ever failed, however recently attempted', async () => {
    // last_catalogued_at null means no success ever. The cooldown is about successes; backing
    // off repeated failures is claimArtistForCatalog's job, not this one's.
    tables.artist_links = [link('always-failing')];
    tables.release_catalog_state = [state('always-failing', 1)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['always-failing']);
  });

  it('ignores a link row with no artist id', async () => {
    tables.artist_links = [link(null), link('real')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['real']);
  });

  it('asks the database only for live saves', async () => {
    tables.artist_links = [link('a')];
    tables.saved_artists = [saved('a')];

    await getStaleCatalogCandidates(10);

    const savedQuery = queries.find(q => q.table === 'saved_artists');
    // `deleted` is a soft-delete flag (migration 017): an unsaved artist keeps a row so other
    // devices can prune it. Treating a tombstone as a save would mis-prioritise the batch.
    expect(savedQuery?.filters).toContainEqual({ kind: 'eq', column: 'deleted', value: false });
    expect(savedQuery?.filters).toContainEqual({ kind: 'not', column: 'artist_id', value: 'is null' });
  });

  it('does not treat a tombstoned save as saved', async () => {
    tables.artist_links = [link('a')];
    tables.saved_artists = [{ artist_id: 'a', deleted: true }];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0].saved).toBe(false);
    expect(result.savedArtists).toBe(0);
  });
});

describe('getStaleCatalogCandidates — ordering', () => {
  it('puts saved artists ahead of everyone, however fresh they are', async () => {
    tables.artist_links = [link('saved-recent'), link('unsaved-ancient'), link('unsaved-never')];
    tables.saved_artists = [saved('saved-recent')];
    tables.release_catalog_state = [state('saved-recent', 200), state('unsaved-ancient', 5_000)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // An alert is a promise to a person, so a saved artist can never starve behind the backfill
    // of everyone else — not even behind an artist who has never been catalogued at all.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'saved-recent',
      'unsaved-never',
      'unsaved-ancient',
    ]);
  });

  it('puts never-catalogued artists first within a group, then the stalest attempt', async () => {
    tables.artist_links = ['recent', 'never', 'ancient', 'middling'].map(id => link(id));
    tables.release_catalog_state = [
      state('recent', 200),
      state('ancient', 5_000),
      state('middling', 900),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No state row at all means we have no releases for them, which is worse than having
    // slightly old ones.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'never',
      'ancient',
      'middling',
      'recent',
    ]);
    expect(result.candidates[0].lastAttemptedAt).toBeNull();
  });

  it('breaks ties on savers, but never lets popularity outrank staleness', async () => {
    tables.artist_links = ['popular-fresh', 'lonely-stale', 'also-fresh'].map(id => link(id));
    tables.saved_artists = [
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('lonely-stale'),
    ];
    tables.release_catalog_state = [
      state('popular-fresh', 200),
      state('also-fresh', 200),
      state('lonely-stale', 4_000),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both saved artists outrank the unsaved one; between them staleness decides, so the
    // artist a single fan saved beats the one three fans saved.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'lonely-stale',
      'popular-fresh',
      'also-fresh',
    ]);
    expect(result.candidates[1].savers).toBe(3);
  });

  it('returns at most the requested batch, and reports the pool behind it', async () => {
    tables.artist_links = Array.from({ length: 40 }, (_, i) => link(`artist-${i}`));
    tables.release_catalog_state = Array.from({ length: 40 }, (_, i) => state(`artist-${i}`, 200 + i));

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[0].artistId).toBe('artist-39'); // attempted longest ago
    expect(result.eligible).toBe(40); // the queue, not the batch
    expect(result.catalogueable).toBe(40);
  });

  it('carries the previous release count, so a run can be read against it afterwards', async () => {
    tables.artist_links = [link('a')];
    tables.release_catalog_state = [
      state('a', 400, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 10, releasesFound: 20 }),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates[0].releasesFound).toBe(20);
  });
});

describe('getStaleCatalogCandidates — paging, not truncation', () => {
  // The bug this guards: PostgREST caps every response at 1,000 rows regardless of `.limit()`,
  // and truncates *silently*. A single read of artist_links returned 1,000 of ~3,900 real rows
  // and looked entirely successful — which would have hidden three quarters of the pool.
  it('pages through a link table larger than one response', async () => {
    tables.artist_links = Array.from({ length: 2_300 }, (_, i) => link(`artist-${i}`));

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalogueable).toBe(2_300);
    expect(queries.filter(q => q.table === 'artist_links')).toHaveLength(3); // 1000+1000+300
  });

  it('pages the catalog state table too, so a big table cannot fake never-attempted', async () => {
    tables.artist_links = Array.from({ length: 1_500 }, (_, i) => link(`artist-${i}`));
    // Everyone has been catalogued recently, so a truncated state read would wrongly report
    // 1,500 never-attempted artists and re-crawl the lot.
    tables.release_catalog_state = Array.from({ length: 1_500 }, (_, i) =>
      state(`artist-${i}`, 2, { hoursAgo: 2 })
    );

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inCooldown).toBe(1_500);
    expect(result.candidates).toHaveLength(0);
  });

  it('pages the saved-artists table', async () => {
    tables.artist_links = Array.from({ length: 1_200 }, (_, i) => link(`artist-${i}`));
    tables.saved_artists = Array.from({ length: 1_200 }, (_, i) => saved(`artist-${i}`));

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok && result.savedArtists).toBe(1_200);
  });
});

describe('getStaleCatalogCandidates — failure is not emptiness', () => {
  it.each([
    ['artist_links', 'catalogue-able artist links'],
    ['saved_artists', 'saved artists'],
    ['release_catalog_state', 'catalog state'],
  ])('reports a failed %s read rather than returning no candidates', async (table, label) => {
    tables.artist_links = [link('a')];
    tables.saved_artists = [saved('a')];
    tables.release_catalog_state = [state('a', 400)];
    failingTable = table;

    const result = await getStaleCatalogCandidates(10);

    // "We couldn't ask" must not render as "nothing needs cataloguing" — that is the shape of
    // the bug the never-cache-uncertainty rule exists to prevent, and here it would make a
    // broken sweep look like a caught-up one, forever.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(label);
  });

  it('is a quiet success, not a failure, when no artist has anything to crawl', async () => {
    const result = await getStaleCatalogCandidates(10);

    expect(result).toEqual({
      ok: true,
      candidates: [],
      catalogueable: 0,
      savedArtists: 0,
      inCooldown: 0,
      eligible: 0,
    });
  });
});
