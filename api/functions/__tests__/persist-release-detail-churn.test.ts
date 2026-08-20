// persistReleaseDetail used to write on every 30-day detail pass whether or not anything had
// changed: the release row's status/date (six indexes on `releases`), a full offers upsert with a
// fresh captured_at (so the rows were guaranteed "different"), and a prune delete. In steady state
// a re-check re-derives exactly what the rows already say, so almost all of that was write churn —
// the same bug persistReleases fixed for `title`, one function up. These tests pin the skip, its
// failure mode (a failed pre-read falls through to writing), and the one write that must never be
// skipped: the detail_checked_at stamp, which is the cooldown's own state AND what the release
// page now shows as "prices checked".

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row { [k: string]: unknown }

const state = {
  release: null as Row | null,
  offers: [] as Row[],
  releaseReadError: null as string | null,
  offersReadError: null as string | null,
};

/** Every write the code attempted, so a skipped write is observable rather than inferred. */
const writes: { table: string; kind: 'update' | 'upsert' | 'delete'; payload?: unknown }[] = [];

function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        not() { return builder; },
        maybeSingle() {
          if (table === 'releases' && state.releaseReadError) {
            return Promise.resolve({ data: null, error: { message: state.releaseReadError } });
          }
          return Promise.resolve({ data: state.release, error: null });
        },
        update(patch: Row) {
          writes.push({ table, kind: 'update', payload: patch });
          return builder;
        },
        upsert(rows: Row[]) {
          writes.push({ table, kind: 'upsert', payload: rows });
          return builder;
        },
        delete() {
          writes.push({ table, kind: 'delete' });
          return builder;
        },
        then(res: (v: unknown) => unknown) {
          if (table === 'release_offers' && state.offersReadError) {
            return Promise.resolve({ data: null, error: { message: state.offersReadError } }).then(res);
          }
          return Promise.resolve({ data: state.offers, error: null }).then(res);
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

const { persistReleaseDetail } = await import('../db');

const RELEASE = {
  releaseId: 'rel-1',
  sourceId: 'src-1',
  url: 'https://artist.bandcamp.com/album/javelin',
  detailCheckedAt: null,
  curatedFields: [] as string[],
};

const DETAIL = {
  releaseDate: '2026-05-01',
  datePrecision: 'day',
  status: 'released',
  offers: [
    { format: 'digital', price: 10, currency: 'USD', availability: 'available' },
    { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
  ],
};

const writesTo = (table: string, kind?: string) =>
  writes.filter(w => w.table === table && (!kind || w.kind === kind));

beforeEach(() => {
  state.release = { status: 'released', release_date: '2026-05-01', date_precision: 'day' };
  // `price` as a string: Postgres `numeric` can serialize that way, and a strict compare
  // against the parser's number would call every offer changed — a silent no-op fix.
  state.offers = [
    { format: 'digital', price: '10', currency: 'USD', availability: 'available' },
    { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
  ];
  state.releaseReadError = null;
  state.offersReadError = null;
  writes.length = 0;
});

describe('a detail pass that re-derives exactly what is stored', () => {
  it('writes only the detail_checked_at stamp', async () => {
    const ok = await persistReleaseDetail(RELEASE, DETAIL);

    expect(ok).toBe(true);
    expect(writesTo('releases')).toHaveLength(0);
    expect(writesTo('release_offers')).toHaveLength(0);
    // The stamp is the cooldown's own state — skipping it would re-fetch every page every pass.
    expect(writesTo('release_sources', 'update')).toHaveLength(1);
  });

  it('still skips when the stored date is a full timestamp serialization', async () => {
    // A `date` column reads back as YYYY-MM-DD, but defend the compare against a timestamp
    // shape anyway — a raw string compare would never match and never skip.
    state.release = { status: 'released', release_date: '2026-05-01T00:00:00+00:00', date_precision: 'day' };

    await persistReleaseDetail(RELEASE, DETAIL);

    expect(writesTo('releases')).toHaveLength(0);
  });
});

describe('a detail pass that found a real change', () => {
  it('writes the release row when status moved', async () => {
    state.release = { status: 'announced', release_date: '2026-05-01', date_precision: 'day' };

    await persistReleaseDetail(RELEASE, DETAIL);

    const updates = writesTo('releases', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ status: 'released' });
  });

  it('rewrites and prunes offers when a price moved', async () => {
    state.offers = [
      { format: 'digital', price: 8, currency: 'USD', availability: 'available' },
      { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
    ];

    await persistReleaseDetail(RELEASE, DETAIL);

    expect(writesTo('release_offers', 'upsert')).toHaveLength(1);
    expect(writesTo('release_offers', 'delete')).toHaveLength(1);
    expect(writesTo('releases')).toHaveLength(0);
  });

  it('rewrites offers when a stored format disappeared from the page', async () => {
    state.offers = [
      ...state.offers,
      { format: 'cassette', price: 12, currency: 'USD', availability: 'available' },
    ];

    await persistReleaseDetail(RELEASE, DETAIL);

    expect(writesTo('release_offers', 'upsert')).toHaveLength(1);
    expect(writesTo('release_offers', 'delete')).toHaveLength(1);
  });
});

describe('failure modes fall toward writing', () => {
  it('writes the release row when its pre-read fails', async () => {
    state.releaseReadError = 'read blipped';

    const ok = await persistReleaseDetail(RELEASE, DETAIL);

    expect(ok).toBe(true);
    expect(writesTo('releases', 'update')).toHaveLength(1);
  });

  it('writes the offers when their pre-read fails', async () => {
    state.offersReadError = 'read blipped';

    await persistReleaseDetail(RELEASE, DETAIL);

    expect(writesTo('release_offers', 'upsert')).toHaveLength(1);
  });
});

describe('rules that predate the skip and must survive it', () => {
  it('leaves the release row alone when the artist curated the date, even when it differs', async () => {
    state.release = { status: 'announced', release_date: '2026-06-01', date_precision: 'day' };

    await persistReleaseDetail({ ...RELEASE, curatedFields: ['release_date'] }, DETAIL);

    expect(writesTo('releases')).toHaveLength(0);
  });

  it('leaves the release row alone when the source has no status to offer', async () => {
    state.release = { status: 'announced', release_date: null, date_precision: null };

    await persistReleaseDetail(RELEASE, { ...DETAIL, status: null, releaseDate: null });

    expect(writesTo('releases')).toHaveLength(0);
  });
});
