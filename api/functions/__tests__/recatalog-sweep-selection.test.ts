// Who the scheduled sweep picks, and who it must not.
//
// The selection is the whole feature: get it wrong and the sweep runs every day, reports
// success, and refreshes the wrong artists — or none — while the alerts it exists to keep
// alive stay quiet. Every rule here is one that would fail silently.
//
// Driven against a recording fake Supabase client rather than a module mock, following
// release-order-query.test.ts, so the real query body runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter {
  kind: 'eq' | 'not' | 'in' | 'limit';
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
  saved_artists: [],
  release_catalog_state: [],
};

/** Set to a table name to make that table's read fail. */
let failingTable: string | null = null;

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
            limit(n: number) {
              query.filters.push({ kind: 'limit', value: n });
              return builder;
            },
            then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
              if (failingTable === table) {
                return Promise.resolve({ data: null, error: { message: 'connection reset' } })
                  .then(resolve, reject);
              }
              // Apply the `in` filter the way PostgREST would, so a chunked read behaves.
              const inFilter = query.filters.find(f => f.kind === 'in');
              let rows = tables[table] ?? [];
              if (inFilter) {
                const wanted = new Set(inFilter.value as string[]);
                rows = rows.filter(r => wanted.has(r[inFilter.column as string] as string));
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

const { getStaleSavedArtistCatalogs, RECATALOG_COOLDOWN_HOURS } = await import('../db');

const HOUR = 3600_000;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();

function saved(artistId: string | null, extra: Record<string, unknown> = {}) {
  return { artist_id: artistId, deleted: false, ...extra };
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
  tables.saved_artists = [];
  tables.release_catalog_state = [];
  failingTable = null;
});

describe('getStaleSavedArtistCatalogs — who is eligible', () => {
  it('only considers artists somebody has saved', async () => {
    tables.saved_artists = [saved('saved-artist')];
    // An artist with catalog state but no saver: catalogued because they were searched once.
    tables.release_catalog_state = [state('saved-artist', 400), state('searched-only', 900)];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => c.artistId)).toEqual(['saved-artist']);
  });

  it('asks the database only for rows that are not tombstoned', async () => {
    tables.saved_artists = [saved('a')];

    await getStaleSavedArtistCatalogs(10);

    const savedQuery = queries.find(q => q.table === 'saved_artists');
    // `deleted` is a soft-delete flag (migration 017): an unsaved artist keeps a row so other
    // devices can prune it. Re-crawling for somebody who unsaved them is pure waste.
    expect(savedQuery?.filters).toContainEqual({ kind: 'eq', column: 'deleted', value: false });
    // artist_id is nullable since migration 014 — a save can be by slug alone.
    expect(savedQuery?.filters).toContainEqual({ kind: 'not', column: 'artist_id', value: 'is null' });
  });

  it('ignores a saved row with no artist id', async () => {
    tables.saved_artists = [saved(null), saved('real')];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['real']);
  });

  it('drops artists still inside the re-catalog cooldown, and counts them', async () => {
    tables.saved_artists = [saved('fresh'), saved('stale')];
    tables.release_catalog_state = [
      state('fresh', 2, { hoursAgo: 2, releasesFound: 12 }),
      state('stale', RECATALOG_COOLDOWN_HOURS + 24, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 24 }),
    ];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Spending a bounded batch on artists claimArtistForCatalog will refuse a moment later
    // would make the sweep a no-op that still reports work.
    expect(result.candidates.map(c => c.artistId)).toEqual(['stale']);
    expect(result.inCooldown).toBe(1);
    expect(result.savedArtists).toBe(2);
  });

  it('keeps an artist whose last success is exactly outside the cooldown', async () => {
    tables.saved_artists = [saved('edge')];
    tables.release_catalog_state = [
      state('edge', RECATALOG_COOLDOWN_HOURS + 1, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 1 }),
    ];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['edge']);
  });

  it('keeps an artist who has only ever failed, however recently attempted', async () => {
    // last_catalogued_at null means no success ever. The cooldown is about successes; the
    // exponential backoff on repeated failures is claimArtistForCatalog's job, not this one's.
    tables.saved_artists = [saved('always-failing')];
    tables.release_catalog_state = [state('always-failing', 1)];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['always-failing']);
  });
});

describe('getStaleSavedArtistCatalogs — ordering', () => {
  it('puts never-attempted artists first, then the stalest attempt', async () => {
    tables.saved_artists = [saved('recent'), saved('never'), saved('ancient'), saved('middling')];
    tables.release_catalog_state = [
      state('recent', 200),
      state('ancient', 5_000),
      state('middling', 900),
    ];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'never' has been saved but no run has ever claimed them — usually the save-time request
    // hit the hourly cap. Nothing else retries it, so it goes to the front.
    expect(result.candidates.map(c => c.artistId)).toEqual(['never', 'ancient', 'middling', 'recent']);
    expect(result.candidates[0].lastAttemptedAt).toBeNull();
  });

  it('breaks ties on savers, but never lets popularity outrank staleness', async () => {
    tables.saved_artists = [
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('lonely-stale'),
      saved('also-fresh'),
    ];
    tables.release_catalog_state = [
      state('popular-fresh', 200),
      state('also-fresh', 200),
      state('lonely-stale', 4_000),
    ];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The one nobody but a single fan saved still comes first. Sorting by popularity would
    // starve exactly the long tail the sweep exists to serve — popular artists stay fresh
    // anyway, because people search them.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'lonely-stale',
      'popular-fresh',
      'also-fresh',
    ]);
    expect(result.candidates[1].savers).toBe(3);
  });

  it('returns at most the requested batch, stalest first', async () => {
    tables.saved_artists = Array.from({ length: 40 }, (_, i) => saved(`artist-${i}`));
    tables.release_catalog_state = Array.from({ length: 40 }, (_, i) => state(`artist-${i}`, 200 + i));

    const result = await getStaleSavedArtistCatalogs(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[0].artistId).toBe('artist-39'); // attempted longest ago
    expect(result.savedArtists).toBe(40); // the population, not the batch
  });

  it('carries the previous release count, so a run can be read against it afterwards', async () => {
    tables.saved_artists = [saved('a')];
    tables.release_catalog_state = [
      state('a', 400, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 10, releasesFound: 20 }),
    ];

    const result = await getStaleSavedArtistCatalogs(10);

    expect(result.ok && result.candidates[0].releasesFound).toBe(20);
  });
});

describe('getStaleSavedArtistCatalogs — failure is not emptiness', () => {
  it('reports a failed saved-artists read rather than returning no candidates', async () => {
    tables.saved_artists = [saved('a')];
    failingTable = 'saved_artists';

    const result = await getStaleSavedArtistCatalogs(10);

    // "We couldn't ask" must not render as "nothing needs re-cataloguing" — that is the shape
    // of the bug the never-cache-uncertainty rule exists to prevent, and here it would make a
    // broken sweep look like a quiet week, forever.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('saved artists');
  });

  it('reports a failed catalog-state read rather than treating everyone as never attempted', async () => {
    tables.saved_artists = [saved('a')];
    failingTable = 'release_catalog_state';

    const result = await getStaleSavedArtistCatalogs(10);

    // Silently treating an unreadable state table as "nobody has ever been catalogued" would
    // send every saved artist to the front of the queue and re-crawl the lot.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('catalog state');
  });

  it('is a quiet success, not a failure, when nobody has saved anything', async () => {
    const result = await getStaleSavedArtistCatalogs(10);

    expect(result).toEqual({ ok: true, candidates: [], savedArtists: 0, inCooldown: 0 });
  });

  it('chunks the state lookup so a large saved population cannot blow up the query string', async () => {
    tables.saved_artists = Array.from({ length: 450 }, (_, i) => saved(`artist-${i}`));

    await getStaleSavedArtistCatalogs(25);

    const stateQueries = queries.filter(q => q.table === 'release_catalog_state');
    expect(stateQueries).toHaveLength(3); // 200 + 200 + 50
    for (const q of stateQueries) {
      expect((q.filters.find(f => f.kind === 'in')?.value as string[]).length).toBeLessThanOrEqual(200);
    }
  });
});
