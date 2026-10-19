// Who the scheduled sweep picks, and who it must not.
//
// The selection is the whole feature: get it wrong and the sweep runs twice a day, reports
// success, and refreshes the wrong artists — or none — while the alerts and artist pages it
// exists to keep current quietly go stale. Every rule here is one that would fail silently.
//
// ## Why this test runs a real Postgres
//
// Until 2026-10-19 the selection was TypeScript over six paged PostgREST reads, and this file
// drove it with a recording fake client. The selection now lives in SQL
// (`supabase/migrations/20261019120000_stale-catalog-candidates.sql`), so a fake client would
// only prove that db.ts can rename eight fields.
//
// So the suite loads **that migration file** into PGlite — Postgres compiled to WebAssembly, no
// Docker, no service to start — and `rpc()` executes against it. The rules below are therefore
// tested against the SQL that production runs, which is stronger than what the fake could do:
// it used to test a TypeScript reimplementation of the rules, and now it tests the rules.
//
// Two deliberate divergences from production, both narrow:
//   * The DDL here is a stand-in carrying only the columns the function reads. The real
//     definitions are in the migrations; this is not a schema test.
//   * `artist_links.artist_id` and `saved_artists.artist_id` are nullable here. The function
//     guards against nulls and that guard needs a column that can hold one.
// The REVOKE/GRANT lines are stripped on load because PGlite has no `anon`, `authenticated` or
// `service_role` roles. They are not skipped silently: `migration-function-grants.test.ts`
// asserts the migration carries them, which is the half a throwaway Postgres cannot check
// anyway (see 20260919140000_revoke-anon-function-execute.sql).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = new URL(
  '../../../supabase/migrations/20261019120000_stale-catalog-candidates.sql',
  import.meta.url
);

const db = new PGlite();

/** Only the columns `stale_catalog_candidates()` reads. See the header. */
const DDL = `
  CREATE TABLE artists (
    id uuid PRIMARY KEY,
    slug text UNIQUE NOT NULL,
    name text NOT NULL
  );
  CREATE TABLE artist_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artist_id uuid,
    platform text NOT NULL,
    url text NOT NULL
  );
  CREATE TABLE saved_artists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT gen_random_uuid(),
    artist_id uuid,
    deleted boolean NOT NULL DEFAULT false
  );
  CREATE TABLE artist_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artist_id uuid UNIQUE NOT NULL,
    verified_at timestamptz
  );
  CREATE TABLE collection_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT gen_random_uuid(),
    artist_name text NOT NULL DEFAULT 'x',
    artist_slug text
  );
  CREATE TABLE release_catalog_state (
    artist_id uuid PRIMARY KEY,
    last_catalogued_at timestamptz,
    last_attempted_at timestamptz NOT NULL DEFAULT now(),
    releases_found integer
  );
`;

await db.exec(DDL);
await db.exec(
  readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter(line => !/^\s*(REVOKE|GRANT)\b/.test(line))
    .join('\n')
);

/** Set to make the rpc fail, standing in for an unreachable database. */
let rpcFails = false;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    async rpc(fn: string, args: Record<string, unknown>) {
      if (rpcFails) return { data: null, error: { message: 'connection reset' } };
      const result = await db.query(`SELECT * FROM ${fn}($1, $2, $3)`, [
        args.p_limit,
        args.p_cooldown_hours,
        args.p_platforms,
      ]);
      return { data: result.rows, error: null };
    },
  }),
}));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { getStaleCatalogCandidates, RECATALOG_COOLDOWN_HOURS } = await import('../db');

// ---------------------------------------------------------------------------
// Fixtures. Artists are named, not uuid'd, so an assertion reads as a sentence;
// `id()` mints a stable uuid per name so the columns keep their production types.

const idsByName = new Map<string, string>();
const namesById = new Map<string, string>();

function id(name: string): string {
  const existing = idsByName.get(name);
  if (existing) return existing;
  const uuid = `00000000-0000-4000-8000-${String(idsByName.size + 1).padStart(12, '0')}`;
  idsByName.set(name, uuid);
  namesById.set(uuid, name);
  return uuid;
}

/** Turn the function's uuids back into the fixture names, so failures are readable. */
const named = (uuid: string) => namesById.get(uuid) ?? uuid;

const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const STALE = RECATALOG_COOLDOWN_HOURS + 24;

async function artist(name: string) {
  await db.query(
    'INSERT INTO artists (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [id(name), `${name}-slug`, name]
  );
}

/**
 * Give an artist something to crawl. Without this they aren't in the pool at all.
 *
 * The URL is part of the fixture because the pool judges shape as well as platform: a
 * `bandcamp.com/search?q=` row is a placeholder, not an artist page.
 */
async function link(name: string | null, platform = 'bandcamp', url?: string) {
  if (name !== null) await artist(name);
  await db.query('INSERT INTO artist_links (artist_id, platform, url) VALUES ($1, $2, $3)', [
    name === null ? null : id(name),
    platform,
    url ?? `https://${platform}.example/artist`,
  ]);
}

/** The "go search Bandcamp yourself" placeholder search-utils writes when nothing resolved. */
async function searchPlaceholder(name: string) {
  await link(name, 'bandcamp', `https://bandcamp.com/search?q=${encodeURIComponent(name)}`);
}

async function saved(name: string, { deleted = false } = {}) {
  await artist(name);
  await db.query('INSERT INTO saved_artists (artist_id, deleted) VALUES ($1, $2)', [
    id(name),
    deleted,
  ]);
}

/** A claim. Verified is what makes it demand; unverified is a wizard somebody opened. */
async function profile(name: string, verified = true) {
  await artist(name);
  await db.query('INSERT INTO artist_profiles (artist_id, verified_at) VALUES ($1, $2)', [
    id(name),
    verified ? ago(500) : null,
  ]);
}

/** A record in somebody's connected collection. Items carry the artist's slug, not their id. */
async function collected(slug: string | null) {
  await db.query('INSERT INTO collection_items (artist_slug) VALUES ($1)', [slug]);
}

async function state(
  name: string,
  attemptedHoursAgo: number,
  catalogued: { hoursAgo: number; releasesFound?: number } | null = null
) {
  await artist(name);
  await db.query(
    `INSERT INTO release_catalog_state (artist_id, last_attempted_at, last_catalogued_at, releases_found)
     VALUES ($1, $2, $3, $4)`,
    [
      id(name),
      ago(attemptedHoursAgo),
      catalogued ? ago(catalogued.hoursAgo) : null,
      catalogued?.releasesFound ?? null,
    ]
  );
}

/** A successful catalogue `hoursAgo` — the shape that freezes an unwanted artist. */
async function catalogued(name: string, hoursAgo: number, releasesFound = 7) {
  await state(name, hoursAgo, { hoursAgo, releasesFound });
}

beforeEach(async () => {
  await db.exec(`TRUNCATE artists, artist_links, saved_artists, artist_profiles,
                          collection_items, release_catalog_state`);
  idsByName.clear();
  namesById.clear();
  rpcFails = false;
});

afterAll(async () => {
  await db.close();
});

describe('getStaleCatalogCandidates — who gets a first catalogue', () => {
  it('does not build a first catalogue for an artist nobody has saved or claimed', async () => {
    await link('searched-only');
    await link('saved-too');
    await saved('saved-too');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The pool used to be everyone with a crawlable link, so any searched artist eventually got
    // a first catalogue. persistSearchResults adds ~46 such artists a day (measured 2026-09-12)
    // against a sweep of 50, so nearly every slot was the expensive first-time case, forever.
    // The searched-but-unwanted tail is counted, not crawled.
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['saved-too']);
    expect(result.awaitingDemand).toBe(1);
    expect(result.catalogueable).toBe(2); // still the pool: the tail hasn't vanished, it's waiting
    expect(result.savedArtists).toBe(1);
    expect(result.eligible).toBe(1);
  });

  it('builds a first catalogue for an artist with a verified claim', async () => {
    await link('claimed');
    await link('nobody');
    await profile('claimed');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A claimed catalogue is the artist's own promotion — the case release pages exist for.
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['claimed']);
    expect(result.candidates[0].claimed).toBe(true);
    expect(result.claimedArtists).toBe(1);
    expect(result.awaitingDemand).toBe(1);
  });

  it('does not treat an unverified claim as demand', async () => {
    // A profile row exists from the moment someone opens the claim wizard. Until verification
    // passes it is a stranger's assertion about an artist, not the artist asking.
    await link('pending');
    await profile('pending', false);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    expect(result.claimedArtists).toBe(0);
    expect(result.awaitingDemand).toBe(1);
  });

  it("builds a first catalogue for an artist in somebody's connected collection", async () => {
    // The import asks for the first 25 artists of a sync directly and leaves the rest to the
    // sweep (MAX_CATALOG_REQUESTS in collection-matching.ts). Those artists are neither saved nor
    // claimed, and a fan has paid for their record — the strongest demand there is.
    await link('bought');
    await link('nobody');
    await collected('bought-slug');
    await collected('bought-slug'); // two copies must not make two artists
    await collected(null);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['bought']);
    expect(result.candidates[0].collected).toBe(true);
    expect(result.collectedArtists).toBe(1);
    expect(result.awaitingDemand).toBe(1);
  });

  it('resolves a collection with many distinct artists', async () => {
    // Slug resolution used to be chunked at 100 ids per PostgREST request; it is a join now,
    // and a collection larger than one old chunk must still resolve completely.
    const names = Array.from({ length: 230 }, (_, i) => `owned-${i}`);
    for (const name of names) {
      await link(name);
      await collected(`${name}-slug`);
    }

    const result = await getStaleCatalogCandidates(300);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.collectedArtists).toBe(230);
    expect(result.candidates).toHaveLength(230);
  });

  it('freezes an already-catalogued artist nobody follows instead of refreshing them', async () => {
    // Round 5 kept refreshing these on the grounds that their page shows prices; round 6
    // (2026-09-19) accepts the stale price, because the alternative is keeping every artist
    // search ever resolved in the 7-day rotation forever. Their catalogue stays visible —
    // frozen, not deleted — and the count is the change's own observable in the sweep log.
    await link('catalogued-unwanted');
    await catalogued('catalogued-unwanted', STALE);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    expect(result.awaitingDemand).toBe(0);
    expect(result.frozenCatalogues).toBe(1);
  });

  it("keeps refreshing a saved artist's stale catalogue — demand unfreezes", async () => {
    // The other half of the trade: a fan is waiting on this artist, so the refresh keeps
    // running whatever the gate does to everyone else.
    await link('catalogued-wanted');
    await saved('catalogued-wanted');
    await catalogued('catalogued-wanted', STALE);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['catalogued-wanted']);
    expect(result.candidates[0].saved).toBe(true);
    expect(result.frozenCatalogues).toBe(0);
  });

  it('drops an unsaved artist whose every attempt has failed', async () => {
    // A state row with no last_catalogued_at means nothing is stored to keep fresh. Before the
    // demand gate these were retried for nobody, each climbing a backoff, forever.
    await link('failed-unwanted');
    await state('failed-unwanted', STALE);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([]);
    // Counted as never catalogued, not as a frozen catalogue: the row exists but nothing in it
    // is worth keeping fresh.
    expect(result.awaitingDemand).toBe(1);
    expect(result.frozenCatalogues).toBe(0);
  });

  it('keeps a saved artist who has only ever failed, however recently attempted', async () => {
    // last_catalogued_at null means no success ever. The cooldown is about successes; backing
    // off repeated failures is claimArtistForCatalog's job, not this one's.
    await link('always-failing');
    await saved('always-failing');
    await state('always-failing', 1);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['always-failing']);
  });
});

describe('getStaleCatalogCandidates — who is in the pool', () => {
  it('excludes artists with nothing crawlable', async () => {
    // catalogArtist records an artist with no bandcamp/discogs/faircamp/jamcoop/mirlo link as an
    // *error*, which bumps consecutive_failures and writes last_error. Sweeping them would
    // spend the batch on artists with nothing to fetch and turn the failure counters to noise.
    await link('real', 'bandcamp');
    await link('site-only', 'officialsite');
    await saved('real');
    await saved('site-only');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['real']);
  });

  // This list must stay identical to catalogArtist's "is there anything to fetch" condition in
  // catalog-artist-background.ts. The two disagreeing is the specific failure this pins: a
  // platform the sweep considers crawlable but catalogArtist doesn't gets swept, rejected, and
  // recorded as a failure, poisoning consecutive_failures for an artist who was never at fault.
  it.each(['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'mirlo'])(
    'treats a %s link as crawlable',
    async platform => {
      await link('a', platform);
      await saved('a');

      const result = await getStaleCatalogCandidates(10);

      expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['a']);
    }
  );

  it('treats a platform outside the catalogueable list as not crawlable', async () => {
    // The negative half of the case above: without it, the it.each only proves the listed
    // platforms are *included*, so a stray addition to CATALOGUEABLE_PLATFORMS would go unnoticed.
    await link('a', 'spotify');
    await link('b', 'ampwall');
    await link('c', 'subvert');
    await saved('a');
    await saved('b');
    await saved('c');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates).toEqual([]);
  });

  it('excludes an artist whose only Bandcamp link is a search placeholder', async () => {
    // `https://bandcamp.com/search?q=X` is a UI affordance, not an artist page. bandcampMusicUrl
    // reduces any URL to origin + /music, so every one of these derives https://bandcamp.com/music
    // — a hard 404. Measured 2026-08-03: 189 such rows, and the 16 that had been swept were the
    // *only* failures in release_catalog_state, each climbing a backoff it could never escape.
    await searchPlaceholder('placeholder-only');
    await link('real');
    await saved('placeholder-only');
    await saved('real');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['real']);
    expect(result.ok && result.catalogueable).toBe(1);
  });

  it('keeps an artist who has a placeholder Bandcamp link but a real Discogs one', async () => {
    // The placeholder is worthless; the Discogs link is not. Dropping the artist entirely would
    // lose a catalogue we can actually build.
    await searchPlaceholder('mixed');
    await link('mixed', 'discogs', 'https://www.discogs.com/artist/12345');
    await saved('mixed');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['mixed']);
  });

  it('keeps a real Bandcamp artist page whose path happens to be deep', async () => {
    // Only the search URL is the placeholder. An album-depth link is a perfectly good artist
    // page — bandcampMusicUrl strips it back to the origin.
    await link('deep', 'bandcamp', 'https://warrenharrison.bandcamp.com/album/x');
    await saved('deep');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['deep']);
  });

  it('counts an artist once however many platforms they are on', async () => {
    await link('a', 'bandcamp');
    await link('a', 'discogs');
    await link('a', 'faircamp');
    await saved('a');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    expect(result.catalogueable).toBe(1);
  });

  it('counts an artist once however many people saved them', async () => {
    await link('a');
    await saved('a');
    await saved('a');
    await saved('a');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedArtists).toBe(1);
    expect(result.candidates[0].savers).toBe(3);
  });

  it('drops artists still inside the re-catalog cooldown, and counts them', async () => {
    // Both saved: with the demand gate an unsaved artist would never reach the cooldown
    // check, and the cooldown is exactly what a *wanted* artist lives on between refreshes.
    await link('fresh');
    await link('stale');
    await saved('fresh');
    await saved('stale');
    await state('fresh', 2, { hoursAgo: 2, releasesFound: 12 });
    await catalogued('stale', STALE);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Spending a bounded batch on artists claimArtistForCatalog will refuse a moment later
    // would make the sweep a no-op that still reports work.
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['stale']);
    expect(result.inCooldown).toBe(1);
    expect(result.eligible).toBe(1);
    expect(result.catalogueable).toBe(2);
  });

  it('measures the cooldown from the last success, not the last attempt', async () => {
    // A failed attempt a minute ago must not buy a week of silence: the backoff for repeated
    // failures is claimArtistForCatalog's, and reading the wrong column here would hide an
    // artist whose catalogue is months old behind a crawl that achieved nothing.
    await link('failed-recently');
    await saved('failed-recently');
    await state('failed-recently', 0.01, { hoursAgo: STALE, releasesFound: 4 });

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['failed-recently']);
    expect(result.inCooldown).toBe(0);
  });

  it('ignores a link row with no artist id', async () => {
    await link(null);
    await link('real');
    await saved('real');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['real']);
  });

  it('does not treat a tombstoned save as saved', async () => {
    // `deleted` is a soft-delete flag (migration 017): an unsaved artist keeps a row so other
    // devices can prune it. Treating a tombstone as a save would mis-prioritise the batch.
    await link('a');
    await saved('a', { deleted: true });
    await catalogued('a', STALE);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A tombstone is an *unsave*, so the artist is treated as having no demand at all: not
    // merely deprioritised but frozen, catalogue and all.
    expect(result.candidates).toEqual([]);
    expect(result.savedArtists).toBe(0);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('counts a live save alongside a tombstone from another fan', async () => {
    await link('a');
    await saved('a');
    await saved('a', { deleted: true });

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One fan unsaved, one did not: the artist is still saved, by exactly one person.
    expect(result.savedArtists).toBe(1);
    expect(result.candidates[0].savers).toBe(1);
  });
});

describe('getStaleCatalogCandidates — ordering', () => {
  it('never lets a wanted artist wait behind a frozen one, however staler the frozen one is', async () => {
    // The frozen artist's catalogue is 25x older, and it changes nothing: the gate removes
    // them from the queue entirely, so a wanted artist can't starve behind refreshes nobody
    // asked for. That was the original point of this ordering test, one step earlier.
    await link('saved-recent');
    await link('unsaved-ancient');
    await link('saved-never');
    await saved('saved-recent');
    await saved('saved-never');
    await catalogued('saved-recent', 200);
    await catalogued('unsaved-ancient', 5_000);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['saved-never', 'saved-recent']);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('puts claimed artists in the priority group with saved ones', async () => {
    await link('claimed-recent');
    await link('unsaved-ancient');
    await link('saved-middling');
    await profile('claimed-recent');
    await saved('saved-middling');
    await catalogued('claimed-recent', 200);
    await catalogued('unsaved-ancient', 5_000);
    await catalogued('saved-middling', 900);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Saved and claimed are the same tier; staleness orders within it. The unsaved artist is
    // frozen, not merely deprioritised.
    expect(result.candidates.map(c => named(c.artistId))).toEqual([
      'saved-middling',
      'claimed-recent',
    ]);
    expect(result.frozenCatalogues).toBe(1);
  });

  it('puts collected artists in the priority group too', async () => {
    await link('bought-recent');
    await link('unsaved-ancient');
    await collected('bought-recent-slug');
    await catalogued('bought-recent', 200);
    await catalogued('unsaved-ancient', 5_000);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates.map(c => named(c.artistId))).toEqual(['bought-recent']);
    expect(result.ok && result.frozenCatalogues).toBe(1);
  });

  it('puts never-catalogued artists first within a group, then the stalest attempt', async () => {
    for (const name of ['recent', 'never', 'ancient', 'middling']) {
      await link(name);
      await saved(name);
    }
    await state('recent', 200);
    await state('ancient', 5_000);
    await state('middling', 900);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No state row at all means we have no releases for them, which is worse than having
    // slightly old ones.
    expect(result.candidates.map(c => named(c.artistId))).toEqual([
      'never',
      'ancient',
      'middling',
      'recent',
    ]);
    expect(result.candidates[0].lastAttemptedAt).toBeNull();
  });

  it('breaks ties on savers, but never lets popularity outrank staleness', async () => {
    for (const name of ['popular-fresh', 'lonely-stale', 'also-fresh', 'frozen-fresh']) {
      await link(name);
    }
    await saved('popular-fresh');
    await saved('popular-fresh');
    await saved('popular-fresh');
    await saved('lonely-stale');
    await state('popular-fresh', 200);
    await catalogued('also-fresh', 200);
    await catalogued('frozen-fresh', 200);
    await state('lonely-stale', 4_000);

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both saved artists outrank each other only by staleness, so the artist a single fan
    // saved beats the one three fans saved; the unsaved catalogued ones are frozen out of
    // the queue entirely, whatever their saver count would have been.
    expect(result.candidates.map(c => named(c.artistId))).toEqual([
      'lonely-stale',
      'popular-fresh',
    ]);
    expect(result.candidates[1].savers).toBe(3);
    expect(result.frozenCatalogues).toBe(2);
  });

  it('breaks a tie between two never-attempted artists on savers', async () => {
    await link('one-fan');
    await link('three-fans');
    await saved('one-fan');
    await saved('three-fans');
    await saved('three-fans');
    await saved('three-fans');

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map(c => named(c.artistId))).toEqual(['three-fans', 'one-fan']);
  });

  it('returns at most the requested batch, and reports the pool behind it', async () => {
    // Saved, or the demand gate freezes them and there is no queue to slice.
    for (let i = 0; i < 40; i++) {
      await link(`artist-${i}`);
      await saved(`artist-${i}`);
      await catalogued(`artist-${i}`, STALE + i);
    }

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(25);
    expect(named(result.candidates[0].artistId)).toBe('artist-39'); // attempted longest ago
    expect(result.eligible).toBe(40); // the queue, not the batch
    expect(result.catalogueable).toBe(40);
  });

  it('carries the previous release count, so a run can be read against it afterwards', async () => {
    await link('a');
    await saved('a');
    await state('a', 400, { hoursAgo: RECATALOG_COOLDOWN_HOURS + 10, releasesFound: 20 });

    const result = await getStaleCatalogCandidates(10);

    expect(result.ok && result.candidates[0].releasesFound).toBe(20);
  });
});

describe('getStaleCatalogCandidates — the whole pool, not a page of it', () => {
  // The bug this guards predates the SQL: PostgREST caps every response at 1,000 rows whatever
  // `.limit()` asks for, and truncates *silently*. One read of artist_links returned 1,000 of
  // ~3,900 real rows and looked entirely successful, hiding three quarters of the pool. The
  // selection is one query now and the cap no longer applies to it — which is precisely the
  // claim worth pinning, because nothing else would notice if a page crept back in.
  it('counts a pool far larger than a PostgREST page', async () => {
    const values = Array.from(
      { length: 2_300 },
      (_, i) => `('00000000-0000-4000-8001-${String(i).padStart(12, '0')}', 'bulk-${i}', 'Bulk ${i}')`
    ).join(',');
    await db.exec(`INSERT INTO artists (id, slug, name) VALUES ${values}`);
    await db.exec(
      `INSERT INTO artist_links (artist_id, platform, url)
       SELECT id, 'bandcamp', 'https://' || slug || '.bandcamp.com' FROM artists`
    );

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalogueable).toBe(2_300);
    expect(result.awaitingDemand).toBe(2_300);
  });

  it('counts catalogue state for a pool far larger than a page', async () => {
    // Everyone has been catalogued recently, so a truncated state read would wrongly report
    // 1,500 never-attempted artists and, with them all saved, re-crawl the lot.
    const values = Array.from(
      { length: 1_500 },
      (_, i) => `('00000000-0000-4000-8002-${String(i).padStart(12, '0')}', 'many-${i}', 'Many ${i}')`
    ).join(',');
    await db.exec(`INSERT INTO artists (id, slug, name) VALUES ${values}`);
    await db.exec(
      `INSERT INTO artist_links (artist_id, platform, url)
       SELECT id, 'bandcamp', 'https://' || slug || '.bandcamp.com' FROM artists`
    );
    await db.exec(`INSERT INTO saved_artists (artist_id) SELECT id FROM artists`);
    await db.exec(
      `INSERT INTO release_catalog_state (artist_id, last_attempted_at, last_catalogued_at)
       SELECT id, now() - interval '2 hours', now() - interval '2 hours' FROM artists`
    );

    const result = await getStaleCatalogCandidates(25);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedArtists).toBe(1_500);
    expect(result.inCooldown).toBe(1_500);
    expect(result.candidates).toHaveLength(0);
  });
});

describe('getStaleCatalogCandidates — failure is not emptiness', () => {
  it('reports an unreachable database rather than returning no candidates', async () => {
    await link('a');
    await saved('a');
    rpcFails = true;

    const result = await getStaleCatalogCandidates(10);

    // "We couldn't ask" must not render as "nothing needs cataloguing" — that is the shape of
    // the bug the never-cache-uncertainty rule exists to prevent, and here it would make a
    // broken sweep look like a caught-up one, forever.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('connection reset');
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
