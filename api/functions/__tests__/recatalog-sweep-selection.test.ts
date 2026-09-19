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
  artist_profiles: [],
  collection_items: [],
  artists: [],
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
              // `.not(col, 'is', null)` is the only negation the selection uses.
              for (const f of query.filters.filter(f => f.kind === 'not' && f.value === 'is null')) {
                rows = rows.filter(r => r[f.column as string] != null);
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

/** An artist_profiles row. Verified is what makes it a claim; unverified is a wizard in progress. */
function profile(artistId: string, verified = true) {
  return { artist_id: artistId, verified_at: verified ? ago(500) : null };
}

/**
 * A record in somebody's connected collection. Items carry the artist's slug, not their id, so
 * the artists table has to know the slug too — `artists()` below is that half of the fixture.
 */
function collected(artistSlug: string | null) {
  return { artist_slug: artistSlug, user_id: 'fan' };
}

function artists(...ids: string[]) {
  return ids.map(id => ({ id, slug: `${id}-slug` }));
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

/** A successful catalogue `hoursAgo` — the shape that keeps an unsaved artist in the pool. */
function catalogued(artistId: string, hoursAgo: number, releasesFound = 7) {
  return state(artistId, hoursAgo, { hoursAgo, releasesFound });
}

const STALE = RECATALOG_COOLDOWN_HOURS + 24;

beforeEach(() => {
  queries.length = 0;
  tables.artist_links = [];
  tables.saved_artists = [];
  tables.artist_profiles = [];
  tables.collection_items = [];
  tables.artists = [];
  tables.release_catalog_state = [];
  failingTable = null;
});

describe('getStaleCatalogCandidates — who gets a first catalogue', () => {
  it('does not build a first catalogue for an artist nobody has saved or claimed', async () => {
    tables.artist_links = [link('searched-only'), link('saved-too')];
    tables.saved_artists = [saved('saved-too')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The pool used to be everyone with a crawlable link, so any searched artist eventually got
    // a first catalogue. persistSearchResults adds ~46 such artists a day (measured 2026-09-12)
    // against a sweep of 50, so nearly every slot was the expensive first-time case, forever.
    // The searched-but-unwanted tail is counted, not crawled.
    expect(result.candidates.map(c => c.artistId)).toEqual(['saved-too']);
    expect(result.awaitingDemand).toBe(1);
    expect(result.catalogueable).toBe(2); // still the pool: the tail hasn't vanished, it's waiting
    expect(result.savedArtists).toBe(1);
    expect(result.eligible).toBe(1);
  });

  it('builds a first catalogue for an artist with a verified claim', async () => {
    tables.artist_links = [link('claimed'), link('nobody')];
    tables.artist_profiles = [profile('claimed')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A claimed catalogue is the artist's own promotion — the case the release pages exist for.
    expect(result.candidates.map(c => c.artistId)).toEqual(['claimed']);
    expect(result.candidates[0].claimed).toBe(true);
    expect(result.claimedArtists).toBe(1);
    expect(result.awaitingDemand).toBe(1);
  });

  it('does not treat an unverified claim as demand', async () => {
    // A profile row exists from the moment someone opens the claim wizard. Until verification
    // passes it is a stranger's assertion about an artist, not the artist asking.
    tables.artist_links = [link('pending')];
    tables.artist_profiles = [profile('pending', false)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    expect(result.claimedArtists).toBe(0);
    expect(result.awaitingDemand).toBe(1);

    const profileQuery = queries.find(q => q.table === 'artist_profiles');
    expect(profileQuery?.filters).toContainEqual({ kind: 'not', column: 'verified_at', value: 'is null' });
  });

  it('builds a first catalogue for an artist in somebody\'s connected collection', async () => {
    // The import asks for the first 25 artists of a sync directly and leaves the rest to the
    // sweep (MAX_CATALOG_REQUESTS in collection-matching.ts). Those artists are neither saved nor
    // claimed, and a fan has paid for their record — the strongest demand there is.
    tables.artist_links = [link('bought'), link('nobody')];
    tables.collection_items = [collected('bought-slug'), collected('bought-slug'), collected(null)];
    tables.artists = artists('bought', 'nobody');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => c.artistId)).toEqual(['bought']);
    expect(result.candidates[0].collected).toBe(true);
    expect(result.collectedArtists).toBe(1);
    expect(result.awaitingDemand).toBe(1);

    // Slugs are resolved to ids in one `in()` per chunk, distinct, and null slugs never asked for.
    const artistQueries = queries.filter(q => q.table === 'artists');
    expect(artistQueries).toHaveLength(1);
    expect(artistQueries[0].filters).toContainEqual({ kind: 'in', column: 'slug', value: ['bought-slug'] });
  });

  it('resolves a collection with more distinct artists than one chunk in several reads', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `owned-${i}`);
    tables.artist_links = ids.map(id => link(id));
    tables.collection_items = ids.map(id => collected(`${id}-slug`));
    tables.artists = artists(...ids);

    const result = await getStaleCatalogCandidates(300);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.collectedArtists).toBe(230);
    expect(result.candidates).toHaveLength(230);
    expect(queries.filter(q => q.table === 'artists')).toHaveLength(3); // 100 + 100 + 30
  });

  it('freezes an already-catalogued artist nobody follows instead of refreshing them', async () => {
    // Round 5 kept refreshing these on the grounds that their page shows prices; round 6
    // (2026-09-19) accepts the stale price, because the alternative is keeping every artist
    // search ever resolved in the 7-day rotation forever. Their catalogue stays visible —
    // frozen, not deleted — and the count is the change's own observable in the sweep log.
    tables.artist_links = [link('catalogued-unwanted')];
    tables.release_catalog_state = [catalogued('catalogued-unwanted', STALE)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    expect(result.awaitingDemand).toBe(0);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('keeps refreshing a saved artist\'s stale catalogue — demand unfreezes', async () => {
    // The other half of the trade: a fan is waiting on this artist, so the refresh keeps
    // running whatever the gate does to everyone else.
    tables.artist_links = [link('catalogued-wanted')];
    tables.saved_artists = [saved('catalogued-wanted')];
    tables.release_catalog_state = [catalogued('catalogued-wanted', STALE)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => c.artistId)).toEqual(['catalogued-wanted']);
    expect(result.candidates[0].saved).toBe(true);
    expect(result.frozenCatalogues).toBe(0);
  });

  it('drops an unsaved artist whose every attempt has failed', async () => {
    // A state row with no last_catalogued_at means nothing is stored to keep fresh. Before the
    // demand gate these were retried for nobody, each climbing a backoff, forever.
    tables.artist_links = [link('failed-unwanted')];
    tables.release_catalog_state = [state('failed-unwanted', STALE)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    expect(result.awaitingDemand).toBe(1);
  });

  it('keeps a saved artist who has only ever failed, however recently attempted', async () => {
    // last_catalogued_at null means no success ever. The cooldown is about successes; backing
    // off repeated failures is claimArtistForCatalog's job, not this one's.
    tables.artist_links = [link('always-failing')];
    tables.saved_artists = [saved('always-failing')];
    tables.release_catalog_state = [state('always-failing', 1)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['always-failing']);
  });
});

describe('getStaleCatalogCandidates — who is in the pool', () => {
  it('excludes artists with nothing crawlable', async () => {
    // catalogArtist records an artist with no bandcamp/discogs/faircamp/jamcoop/mirlo link as an
    // *error*, which bumps consecutive_failures and writes last_error. Sweeping them would
    // spend the batch on artists with nothing to fetch and turn the failure counters to noise.
    tables.artist_links = [link('real', 'bandcamp'), link('site-only', 'officialsite')];
    tables.saved_artists = [saved('real'), saved('site-only')];

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
      tables.saved_artists = [saved('a')];

      const result = await getStaleCatalogCandidates(10);

      expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['a']);
    }
  );

  it('treats a platform outside the catalogueable list as not crawlable', async () => {
    // The negative half of the case above: without it, the it.each only proves the listed
    // platforms are *included*, so a stray addition to CATALOGUEABLE_PLATFORMS would go unnoticed.
    tables.artist_links = [link('a', 'spotify'), link('b', 'ampwall'), link('c', 'subvert')];
    tables.saved_artists = [saved('a'), saved('b'), saved('c')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates).toEqual([]);
  });

  it('excludes an artist whose only Bandcamp link is a search placeholder', async () => {
    // `https://bandcamp.com/search?q=X` is a UI affordance, not an artist page. bandcampMusicUrl
    // reduces any URL to origin + /music, so every one of these derives https://bandcamp.com/music
    // — a hard 404. Measured 2026-08-03: 189 such rows, and the 16 that had been swept were the
    // *only* failures in release_catalog_state, each climbing a backoff it could never escape.
    tables.artist_links = [searchPlaceholder('placeholder-only'), link('real')];
    tables.saved_artists = [saved('placeholder-only'), saved('real')];

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
    tables.saved_artists = [saved('mixed')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['mixed']);
  });

  it('keeps a real Bandcamp artist page whose path happens to be deep', async () => {
    // Only the search URL is the placeholder. An album-depth link is a perfectly good artist
    // page — bandcampMusicUrl strips it back to the origin.
    tables.artist_links = [link('deep', 'bandcamp', 'https://warrenharrison.bandcamp.com/album/x')];
    tables.saved_artists = [saved('deep')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['deep']);
  });

  it('counts an artist once however many platforms they are on', async () => {
    tables.artist_links = [link('a', 'bandcamp'), link('a', 'discogs'), link('a', 'faircamp')];
    tables.saved_artists = [saved('a')];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    expect(result.catalogueable).toBe(1);
  });

  it('drops artists still inside the re-catalog cooldown, and counts them', async () => {
    // Both saved: with the demand gate an unsaved artist would never reach the cooldown
    // check, and the cooldown is exactly what a *wanted* artist lives on between refreshes.
    tables.artist_links = [link('fresh'), link('stale')];
    tables.saved_artists = [saved('fresh'), saved('stale')];
    tables.release_catalog_state = [
      state('fresh', 2, { hoursAgo: 2, releasesFound: 12 }),
      catalogued('stale', STALE),
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

  it('ignores a link row with no artist id', async () => {
    tables.artist_links = [link(null), link('real')];
    tables.saved_artists = [saved('real')];

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
    tables.release_catalog_state = [catalogued('a', STALE)];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A tombstone is an *unsave*, so the artist is treated as having no demand at all: not
    // merely deprioritised but frozen, catalogue and all.
    expect(result.candidates).toEqual([]);
    expect(result.savedArtists).toBe(0);
    expect(result.frozenCatalogues).toBe(1);
  });
});

describe('getStaleCatalogCandidates — ordering', () => {
  it('never lets a wanted artist wait behind a frozen one, however staler the frozen one is', async () => {
    // The frozen artist's catalogue is 25x older, and it changes nothing: the gate removes
    // them from the queue entirely, so a wanted artist can't starve behind refreshes nobody
    // asked for. That was the original point of this ordering test, one step earlier.
    tables.artist_links = [link('saved-recent'), link('unsaved-ancient'), link('saved-never')];
    tables.saved_artists = [saved('saved-recent'), saved('saved-never')];
    tables.release_catalog_state = [
      catalogued('saved-recent', 200),
      catalogued('unsaved-ancient', 5_000),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => c.artistId)).toEqual(['saved-never', 'saved-recent']);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('puts claimed artists in the priority group with saved ones', async () => {
    tables.artist_links = [link('claimed-recent'), link('unsaved-ancient'), link('saved-middling')];
    tables.artist_profiles = [profile('claimed-recent')];
    tables.saved_artists = [saved('saved-middling')];
    tables.release_catalog_state = [
      catalogued('claimed-recent', 200),
      catalogued('unsaved-ancient', 5_000),
      catalogued('saved-middling', 900),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Saved and claimed are the same tier; staleness orders within it. The unsaved artist is
    // frozen, not merely deprioritised.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'saved-middling',
      'claimed-recent',
    ]);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('puts collected artists in the priority group too', async () => {
    tables.artist_links = [link('bought-recent'), link('unsaved-ancient')];
    tables.collection_items = [collected('bought-recent-slug')];
    tables.artists = artists('bought-recent', 'unsaved-ancient');
    tables.release_catalog_state = [
      catalogued('bought-recent', 200),
      catalogued('unsaved-ancient', 5_000),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => c.artistId)).toEqual(['bought-recent']);
    expect(result.ok && result.frozenCatalogues).toBe(1);
  });

  it('puts never-catalogued artists first within a group, then the stalest attempt', async () => {
    tables.artist_links = ['recent', 'never', 'ancient', 'middling'].map(id => link(id));
    tables.saved_artists = ['recent', 'never', 'ancient', 'middling'].map(id => saved(id));
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
    tables.artist_links = ['popular-fresh', 'lonely-stale', 'also-fresh', 'frozen-fresh'].map(id => link(id));
    tables.saved_artists = [
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('popular-fresh'),
      saved('lonely-stale'),
    ];
    tables.release_catalog_state = [
      state('popular-fresh', 200),
      catalogued('also-fresh', 200),
      catalogued('frozen-fresh', 200),
      state('lonely-stale', 4_000),
    ];

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both saved artists outrank each other only by staleness, so the artist a single fan
    // saved beats the one three fans saved; the unsaved catalogued ones are frozen out of
    // the queue entirely, whatever their saver count would have been.
    expect(result.candidates.map(c => c.artistId)).toEqual([
      'lonely-stale',
      'popular-fresh',
    ]);
    expect(result.candidates[1].savers).toBe(3);
    expect(result.frozenCatalogues).toBe(2);
  });

  it('returns at most the requested batch, and reports the pool behind it', async () => {
    // Saved, or the demand gate freezes them and there is no queue to slice.
    tables.artist_links = Array.from({ length: 40 }, (_, i) => link(`artist-${i}`));
    tables.saved_artists = Array.from({ length: 40 }, (_, i) => saved(`artist-${i}`));
    tables.release_catalog_state = Array.from({ length: 40 }, (_, i) =>
      catalogued(`artist-${i}`, STALE + i)
    );

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
    tables.saved_artists = [saved('a')];
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
    // 1,500 never-attempted artists and, with them all saved, re-crawl the lot.
    tables.saved_artists = Array.from({ length: 1_500 }, (_, i) => saved(`artist-${i}`));
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

  it('pages the claimed-profiles table', async () => {
    tables.artist_links = Array.from({ length: 1_200 }, (_, i) => link(`artist-${i}`));
    tables.artist_profiles = Array.from({ length: 1_200 }, (_, i) => profile(`artist-${i}`));

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok && result.claimedArtists).toBe(1_200);
  });
});

describe('getStaleCatalogCandidates — failure is not emptiness', () => {
  it.each([
    ['artist_links', 'catalogue-able artist links'],
    ['saved_artists', 'saved artists'],
    ['artist_profiles', 'claimed artist profiles'],
    ['collection_items', 'collection items'],
    ['artists', 'collection artists'],
    ['release_catalog_state', 'catalog state'],
  ])('reports a failed %s read rather than returning no candidates', async (table, label) => {
    tables.artist_links = [link('a')];
    tables.saved_artists = [saved('a')];
    tables.artist_profiles = [profile('a')];
    tables.collection_items = [collected('a-slug')];
    tables.artists = artists('a');
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
      claimedArtists: 0,
      collectedArtists: 0,
      awaitingDemand: 0,
      frozenCatalogues: 0,
      inCooldown: 0,
      eligible: 0,
    });
  });
});
