// `getReleaseDetail` — the query behind /api/release/{artist}/{release}.
//
// Two properties here are worth locking down, and they are the two a well-meaning tidy-up would
// break in opposite directions:
//
//   1. **`is_hidden` is filtered.** An artist suppressing a release must be indistinguishable
//      from one that was never catalogued. Verified against three real hidden rows in production
//      too, but a filter that only exists in production is one refactor from vanishing.
//   2. **`needs_review` is *not* filtered** — unlike `getFeedReleasesForUser` and the alert read,
//      which both exclude it. A tier-3 fuzzy flag means "we aren't sure this release is
//      *distinct*", not "this is wrong": a good reason to keep it out of someone's calendar, a
//      bad reason to 404 a person who followed a direct link. Production currently has zero
//      `needs_review` rows, so this is the only place that asymmetry can actually be checked.
//
// Driven against a recording fake Supabase client rather than the module mock the endpoint test
// uses, following merge-releases-guard.test.ts, because the point is to exercise the real body.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Filter {
  table: string;
  column: string;
  value: unknown;
}

/** Every `.eq()` the function applied, in order — the surface these assertions read. */
const filters: Filter[] = [];

let artistRow: Record<string, unknown> | null = { id: 'artist-1', name: 'Boy Harsher', image_url: null };
let artistError: { message: string } | null = null;
let releaseRow: Record<string, unknown> | null = null;
let releaseError: { message: string } | null = null;

function makeClient() {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          // `.eq()` chains, and the terminal call is `.maybeSingle()`. Returning the same
          // builder from `eq` lets an arbitrary number of filters be recorded.
          const builder = {
            eq(column: string, value: unknown) {
              filters.push({ table, column, value });
              return builder;
            },
            maybeSingle() {
              return table === 'artists'
                ? Promise.resolve({ data: artistRow, error: artistError })
                : Promise.resolve({ data: releaseRow, error: releaseError });
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

const { getReleaseDetail } = await import('../db');

/** A release row as PostgREST returns it: snake_case, nested sources and offers. */
function row(over: Record<string, unknown> = {}) {
  return {
    slug: 'get-mean',
    title: 'GET MEAN',
    release_type: 'album',
    release_date: '2026-09-18',
    date_precision: 'day',
    status: 'announced',
    artwork_url: 'https://f4.bcbits.com/img/a0780870664_2.jpg',
    release_sources: [
      {
        platform: 'bandcamp',
        url: 'https://boyharsher.bandcamp.com/album/get-mean',
        detail_checked_at: '2026-08-01T09:18:25.966+00:00',
        release_offers: [
          {
            format: 'vinyl',
            price: 30,
            currency: 'USD',
            availability: 'available',
            captured_at: '2026-08-01T09:18:25.833+00:00',
          },
        ],
      },
    ],
    ...over,
  };
}

function releaseFilters() {
  return filters.filter(f => f.table === 'releases');
}

beforeEach(() => {
  filters.length = 0;
  artistRow = { id: 'artist-1', name: 'Boy Harsher', image_url: null };
  artistError = null;
  releaseRow = row();
  releaseError = null;
});

describe('the filters it applies', () => {
  it('scopes the release to the artist id and slug', async () => {
    await getReleaseDetail('boy-harsher', 'get-mean');

    expect(filters).toContainEqual({ table: 'artists', column: 'slug', value: 'boy-harsher' });
    expect(releaseFilters()).toContainEqual({ table: 'releases', column: 'artist_id', value: 'artist-1' });
    expect(releaseFilters()).toContainEqual({ table: 'releases', column: 'slug', value: 'get-mean' });
  });

  it('filters hidden releases in the query, not after it', async () => {
    await getReleaseDetail('boy-harsher', 'get-mean');
    expect(releaseFilters()).toContainEqual({ table: 'releases', column: 'is_hidden', value: false });
  });

  // The asymmetry with the feed and alert reads, which is deliberate. If this ever starts
  // filtering, every fuzzy-flagged release 404s for anyone following a direct link to it.
  it('does not filter needs_review', async () => {
    await getReleaseDetail('boy-harsher', 'get-mean');
    expect(releaseFilters().map(f => f.column)).not.toContain('needs_review');
  });
});

describe('absence versus failure', () => {
  it('reports a genuinely missing artist as absent, not failed', async () => {
    artistRow = null;
    expect(await getReleaseDetail('nobody', 'get-mean')).toEqual({ detail: null, failed: false });
  });

  it('reports a genuinely missing release as absent, not failed', async () => {
    releaseRow = null;
    expect(await getReleaseDetail('boy-harsher', 'nope')).toEqual({ detail: null, failed: false });
  });

  // A read error is not a negative result. Collapsing the two is the single most repeated bug
  // class in this codebase, and here it would 404 every release during a Supabase incident.
  it('reports a failed artist read as failed, not absent', async () => {
    artistError = { message: 'connection reset' };
    expect(await getReleaseDetail('boy-harsher', 'get-mean')).toEqual({ detail: null, failed: true });
  });

  it('reports a failed release read as failed, not absent', async () => {
    releaseError = { message: 'statement timeout' };
    expect(await getReleaseDetail('boy-harsher', 'get-mean')).toEqual({ detail: null, failed: true });
  });

  // Missing credentials mean we can't answer, not that the release is gone. Reached through a
  // fresh module instance because `getClient()` memoizes, and because the env vars set above for
  // every other test in this file are exactly what this branch needs to be absent.
  it('reports missing Supabase credentials as failed, not absent', async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    vi.resetModules();

    try {
      const fresh = await import('../db');
      expect(await fresh.getReleaseDetail('boy-harsher', 'get-mean')).toEqual({
        detail: null,
        failed: true,
      });
    } finally {
      process.env.SUPABASE_URL = url;
      process.env.SUPABASE_SERVICE_KEY = key;
    }
  });
});

describe('the shape it returns', () => {
  it('maps snake_case columns onto the camelCase the endpoint serializes', async () => {
    const { detail, failed } = await getReleaseDetail('boy-harsher', 'get-mean');

    expect(failed).toBe(false);
    expect(detail).toEqual({
      artist: { slug: 'boy-harsher', name: 'Boy Harsher', imageUrl: null },
      release: {
        slug: 'get-mean',
        title: 'GET MEAN',
        releaseType: 'album',
        releaseDate: '2026-09-18',
        datePrecision: 'day',
        status: 'announced',
        artworkUrl: 'https://f4.bcbits.com/img/a0780870664_2.jpg',
        sources: [
          {
            platform: 'bandcamp',
            url: 'https://boyharsher.bandcamp.com/album/get-mean',
            detailCheckedAt: '2026-08-01T09:18:25.966+00:00',
            offers: [
              {
                format: 'vinyl',
                price: 30,
                currency: 'USD',
                availability: 'available',
                capturedAt: '2026-08-01T09:18:25.833+00:00',
              },
            ],
          },
        ],
      },
    });
  });

  // PostgREST returns null, not [], for an embed with no rows. Both have to survive as [].
  it('turns a null sources or offers embed into an empty array', async () => {
    releaseRow = row({ release_sources: null });
    expect((await getReleaseDetail('a', 'b')).detail?.release.sources).toEqual([]);

    releaseRow = row({
      release_sources: [{ platform: 'bandcamp', url: 'https://x', detail_checked_at: null, release_offers: null }],
    });
    const [source] = (await getReleaseDetail('a', 'b')).detail!.release.sources;
    expect(source.offers).toEqual([]);
    expect(source.detailCheckedAt).toBeNull();
  });
});
