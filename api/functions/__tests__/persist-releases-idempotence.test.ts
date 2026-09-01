// Re-cataloguing an artist whose releases haven't changed should write nothing to `releases`.
//
// It used to write everything. The patch assigned `title` unconditionally, so every pass over an
// artist rewrote every release row it already held — and the scheduled sweep re-catalogues ~100
// artists a day. Postgres has no in-place update, so each of those was a new tuple version plus an
// entry in all six of this table's indexes, for a title that was byte-identical.
//
// The COALESCE-in-JS semantics around it are load-bearing and easy to break while "optimising", so
// they're pinned here too: never blank something already set, never touch a field the artist
// curated.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {};
/** Every write attempted, so a skipped write is observable. */
const writes: { table: string; op: 'update' | 'insert' | 'upsert'; patch: Row }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const rowsOf = () => (tables[table] ??= []);
      const matched = () => rowsOf().filter(r => eqs.every(([c, v]) => r[c] === v));

      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return builder; },
        in() { return builder; },
        update(patch: Row) {
          writes.push({ table, op: 'update', patch });
          return {
            eq: (_c: string, id: unknown) => {
              const row = rowsOf().find(r => r.id === id);
              if (row) Object.assign(row, patch);
              // Real Supabase's builder is both awaitable on its own (`.update().eq()`) and
              // chainable into `.select().single()` (`.update().eq().select().single()`) — this
              // has to support both, the same as `insert` below.
              return {
                select: () => ({ single: () => Promise.resolve({ data: row ?? null, error: null }) }),
                then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve, reject),
              };
            },
          };
        },
        insert(patch: Row) {
          writes.push({ table, op: 'insert', patch });
          const row = { id: `rel-${rowsOf().length + 1}`, ...patch };
          rowsOf().push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
        },
        upsert(patch: Row) {
          writes.push({ table, op: 'upsert', patch });
          const row = { id: `src-${rowsOf().length + 1}`, detail_checked_at: null, ...patch };
          rowsOf().push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
        },
        maybeSingle() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        single() { return Promise.resolve({ data: matched()[0] ?? null, error: null }); },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({ data: matched(), error: null }).then(res);
        },
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { persistReleases } = await import('../db');

const ARTIST = 'a1';

function incoming(overrides: Partial<{ title: string; artworkUrl: string | null; releaseDate: string | null }> = {}) {
  return [{
    title: overrides.title ?? 'First Record',
    slug: 'first-record',
    matchKey: 'firstrecord',
    releaseType: 'album',
    releaseDate: overrides.releaseDate === undefined ? '2026-01-01' : overrides.releaseDate,
    datePrecision: 'day',
    status: 'released',
    artworkUrl: overrides.artworkUrl === undefined ? 'https://img/art.jpg' : overrides.artworkUrl,
    source: { platform: 'bandcamp', url: 'https://someone.bandcamp.com/album/first-record', externalId: 'album-111' },
  }];
}

const SOURCE_URL = 'https://someone.bandcamp.com/album/first-record';

/** The release_sources row a previous catalogue pass would have left behind. */
function seedSource(overrides: Row = {}) {
  tables.release_sources = [{
    id: 's1',
    release_id: 'r1',
    platform: 'bandcamp',
    url: SOURCE_URL,
    external_id: 'album-111',
    source: 'auto',
    detail_checked_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }];
}

/** A release row a previous catalogue pass would have left behind. */
function seedRelease(overrides: Row = {}) {
  tables.releases = [{
    id: 'r1',
    artist_id: ARTIST,
    slug: 'first-record',
    title: 'First Record',
    match_key: 'firstrecord',
    release_type: 'album',
    release_date: '2026-01-01',
    artwork_url: 'https://img/art.jpg',
    curated_fields: null,
    ...overrides,
  }];
  tables.release_sources = [];
}

const releaseWrites = () => writes.filter(w => w.table === 'releases');

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
});

describe('re-cataloguing an unchanged release', () => {
  it('does not write to releases at all', async () => {
    seedRelease();

    const written = await persistReleases(ARTIST, incoming() as never);

    expect(releaseWrites()).toHaveLength(0);
    // Still returned, so the detail pass can consider it — skipping the *write* must not mean
    // dropping the release from the pipeline.
    expect(written).toHaveLength(1);
  });

  it('writes nothing even when the incoming row has less information than the stored one', async () => {
    seedRelease();
    await persistReleases(ARTIST, incoming({ artworkUrl: null, releaseDate: null }) as never);
    expect(releaseWrites()).toHaveLength(0);
  });
});

describe('re-cataloguing a release that changed', () => {
  it('writes the new title, and only the title', async () => {
    seedRelease();

    await persistReleases(ARTIST, incoming({ title: 'First Record (Remastered)' }) as never);

    expect(releaseWrites()).toHaveLength(1);
    expect(releaseWrites()[0].patch).toEqual({ title: 'First Record (Remastered)' });
  });

  it('fills in artwork that was missing', async () => {
    seedRelease({ artwork_url: null });

    await persistReleases(ARTIST, incoming() as never);

    expect(releaseWrites()).toHaveLength(1);
    expect(releaseWrites()[0].patch).toEqual({ artwork_url: 'https://img/art.jpg' });
  });

  it('fills in a date that was missing, with its precision', async () => {
    seedRelease({ release_date: null });

    await persistReleases(ARTIST, incoming() as never);

    expect(releaseWrites()[0].patch).toEqual({ release_date: '2026-01-01', date_precision: 'day' });
  });
});

describe('what ingest must never overwrite', () => {
  it('leaves a curated title alone even when it differs', async () => {
    seedRelease({ curated_fields: ['title'] });

    await persistReleases(ARTIST, incoming({ title: 'Something Else' }) as never);

    expect(releaseWrites()).toHaveLength(0);
    expect(tables.releases[0].title).toBe('First Record');
  });

  it('does not blank artwork that is already set', async () => {
    seedRelease();
    await persistReleases(ARTIST, incoming({ artworkUrl: null }) as never);
    expect(tables.releases[0].artwork_url).toBe('https://img/art.jpg');
  });
});

// release_sources had the same unconditional-write problem as `releases`: every pass restated a
// URL that hadn't moved, purely to stamp `last_seen_at` — a column nothing in the codebase reads.
describe('the source row', () => {
  const sourceWrites = () => writes.filter(w => w.table === 'release_sources');

  it('is not rewritten when the URL and external id are unchanged', async () => {
    seedRelease();
    seedSource();

    const written = await persistReleases(ARTIST, incoming() as never);

    expect(sourceWrites()).toHaveLength(0);
    // The existing row is still what the detail pass gets handed, including its detail_checked_at
    // — otherwise a skipped write would look like a new source and re-fetch the release page.
    expect(written[0]).toMatchObject({ sourceId: 's1', detailCheckedAt: '2026-08-01T00:00:00.000Z' });
  });

  it('is written when the URL moved', async () => {
    seedRelease();
    seedSource({ url: 'https://someone.bandcamp.com/album/first-record-2' });

    await persistReleases(ARTIST, incoming() as never);

    expect(sourceWrites()).toHaveLength(1);
    expect(sourceWrites()[0].patch).toMatchObject({ url: SOURCE_URL });
  });

  it('is written when the external id changed', async () => {
    seedRelease();
    seedSource({ external_id: 'album-999' });

    await persistReleases(ARTIST, incoming() as never);

    expect(sourceWrites()).toHaveLength(1);
  });

  // Regression for #507: upsertReleaseSource used to delete the *new* key
  // (`prior?.external_id ?? externalId` collapses to `externalId` whenever the null-id fallback
  // matched), leaving the old null-keyed map entry stale. A second source for the same release
  // and platform later in the same pass would then find that stale entry and overwrite the row
  // the first source had just upgraded, wiping out the external id it had just been given.
  it('does not let a second null-external-id source in the same pass clobber the first upgrade', async () => {
    seedRelease();
    seedSource({ external_id: null });

    const secondSource = {
      ...incoming()[0],
      source: { platform: 'bandcamp', url: 'https://someone.bandcamp.com/album/first-record-alt', externalId: null },
    };

    await persistReleases(ARTIST, [...incoming(), secondSource] as never);

    const upgraded = tables.release_sources.find((r: Row) => r.id === 's1');
    expect(upgraded).toMatchObject({ external_id: 'album-111', url: SOURCE_URL });

    // The second source is a genuinely different row — not a clobber of s1.
    const others = tables.release_sources.filter((r: Row) => r.id !== 's1');
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ external_id: null, url: 'https://someone.bandcamp.com/album/first-record-alt' });
  });

  // Rule 1 of upsertReleaseSource. A claimed URL is an artist's own correction and a re-crawl must
  // hand it back untouched rather than restating what ingest thinks the URL should be.
  it('never overwrites a claimed source, even when the URL differs', async () => {
    seedRelease();
    seedSource({ source: 'claimed', url: 'https://artist-corrected.bandcamp.com/album/real' });

    const written = await persistReleases(ARTIST, incoming() as never);

    expect(sourceWrites()).toHaveLength(0);
    expect(written[0].url).toBe('https://artist-corrected.bandcamp.com/album/real');
  });
});

describe('a release we have never seen', () => {
  it('inserts it', async () => {
    tables.releases = [];
    tables.release_sources = [];

    await persistReleases(ARTIST, incoming() as never);

    const inserts = releaseWrites().filter(w => w.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].patch).toMatchObject({ title: 'First Record', artist_id: ARTIST });
  });
});
