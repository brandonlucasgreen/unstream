// What stops the release-detail pass — and what must not.
//
// The pass reads one page per release for dates, formats and prices, so it is the one part of
// ingest whose cost scales with catalogue size rather than artist count. Two limits bound it: a
// wall-clock deadline (`DETAIL_BUDGET_MS`) and an invocation-wide fetch count
// (`MAX_DETAIL_FETCHES_PER_RUN`). **The deadline is meant to be the one that fires.**
//
// It wasn't. The count sat at 100 and was shared across a batch of up to 25 artists — 4 fetches
// each against a per-artist cap of 40 — so the artists late in every batch got no detail pass at
// all, while the invocation finished in a 5-7 minute span against a 9-minute deadline. Measured
// against production on 2026-08-07 that left 1,057 `release_sources` never read, 867 of them
// Bandcamp. Once a source is read it gets a price 99%+ of the time, so nothing here was a parser
// problem; it was rationing.
//
// These tests pin both halves: the count no longer rations a batch, and the deadline still stops
// the pass. Pacing is asserted too, because the fix was to raise a *count* while leaving the
// request *rate* alone — the reverse would be the outage this codebase has had before.
//
// Timers are faked so the 1s-per-request pacing costs no real seconds. That means Date.now()
// advances by exactly the pacing the code asks for, which is what makes the deadline assertions
// meaningful rather than incidental.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimArtistForCatalog: vi.fn(),
  getArtistForCatalog: vi.fn(),
  persistReleases: vi.fn(),
  persistFaircampReleases: vi.fn(),
  persistReleaseDetail: vi.fn(),
  recordCatalogOutcome: vi.fn(),
  attachDiscoveredSource: vi.fn(),
  persistDiscogsReleases: vi.fn(),
  persistJamcoopReleases: vi.fn(),
  persistMirloReleases: vi.fn(),
  persistMusicBrainzEnrichment: vi.fn(),
  safeFetch: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../db', () => ({
  claimArtistForCatalog: mocks.claimArtistForCatalog,
  getArtistForCatalog: mocks.getArtistForCatalog,
  persistReleases: mocks.persistReleases,
  persistFaircampReleases: mocks.persistFaircampReleases,
  persistReleaseDetail: mocks.persistReleaseDetail,
  recordCatalogOutcome: mocks.recordCatalogOutcome,
  attachDiscoveredSource: mocks.attachDiscoveredSource,
  persistDiscogsReleases: mocks.persistDiscogsReleases,
  persistJamcoopReleases: mocks.persistJamcoopReleases,
  persistMirloReleases: mocks.persistMirloReleases,
  persistMusicBrainzEnrichment: mocks.persistMusicBrainzEnrichment,
}));

vi.mock('../safe-fetch', () => ({
  safeFetch: mocks.safeFetch,
  safeHostname: (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '<unparseable>';
    }
  },
}));

// The parsers, the allowlist and the budget arithmetic are all real. Only the network and the
// database are stubbed.
import { handler } from '../catalog-artist-background';

const SECRET = 'test-secret-value';

/** A grid page carrying `count` releases, in the shape ingestBandcampGrid actually reads. */
function gridPage(count: number): string {
  const items = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `<li data-item-id="album-${n}" data-band-id="203035041" class="music-grid-item">
      <a href="/album/release-${n}">
        <div class="art"><img src="https://f4.bcbits.com/img/a105950668${n}_2.jpg" alt="" /></div>
        <p class="title">Release ${n}</p>
      </a>
    </li>`;
  });
  return `<html><body><ol class="editable-grid music-grid">${items.join('\n')}</ol></body></html>`;
}

/** A release page with a real date and a real digital offer, as JSON-LD. */
function detailPage(): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'MusicAlbum',
    datePublished: '15 Sep 2023 00:00:00 GMT',
    albumRelease: [
      {
        '@type': 'MusicRelease',
        musicReleaseFormat: 'DigitalFormat',
        offers: { '@type': 'Offer', price: 10, priceCurrency: 'USD', availability: 'InStock' },
      },
    ],
  })}</script></head><body></body></html>`;
}

function ok(body: string, url: string) {
  return { ok: true, status: 200, url, text: () => Promise.resolve(body) };
}

function artistIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${i}`.padStart(8, '0') + '-1111-1111-1111-111111111111');
}

/** Bandcamp: every artist has `releasesEach` releases, none of them ever read. */
function setUpBandcamp(releasesEach: number) {
  mocks.claimArtistForCatalog.mockResolvedValue(true);
  mocks.getArtistForCatalog.mockImplementation((id: string) =>
    Promise.resolve({ id, name: `Artist ${id.slice(0, 4)}`, bandcampUrl: `https://a${id.slice(0, 4)}.bandcamp.com` })
  );
  mocks.persistReleases.mockImplementation((artistId: string, releases: { source: { url: string } }[]) =>
    Promise.resolve(
      releases.slice(0, releasesEach).map((r, i) => ({
        releaseId: `${artistId}-rel-${i}`,
        sourceId: `${artistId}-src-${i}`,
        url: r.source.url,
        detailCheckedAt: null,
        curatedFields: [],
      }))
    )
  );
  mocks.persistReleaseDetail.mockResolvedValue(true);
}

/** How many of the recorded fetches were individual release pages rather than a grid. */
function detailFetchCount(): number {
  return mocks.safeFetch.mock.calls.filter(c => String(c[0]).includes('/album/')).length;
}

function post(body: unknown) {
  return handler({ httpMethod: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
}

/** Run the handler to completion with timers faked, so pacing costs no real time. */
async function runHandler(body: unknown) {
  const promise = post(body);
  await vi.runAllTimersAsync();
  return promise;
}

const originalEnv = { ...process.env };
let logs: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  process.env.INTERNAL_FUNCTION_SECRET = SECRET;
  process.env.RELEASE_CATALOG_ENABLED = 'true';
  process.env.URL = 'https://unstream.stream';

  logs = [];
  vi.spyOn(console, 'log').mockImplementation(m => void logs.push(String(m)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // MusicBrainz enrichment runs for every artist. Declining it keeps these tests about the
  // Bandcamp and Faircamp budgets, and matches what the pass does with an unreachable upstream.
  mocks.fetch.mockResolvedValue({ ok: false, status: 503 } as Response);
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe('the detail pass is bounded by its deadline, not by a fetch count', () => {
  // The regression test for the starvation. Three artists with 40 releases each is 120 due pages,
  // above the old invocation-wide cap of 100 — so at 100 the third artist would be cut off
  // partway, which is exactly what left whole artists' catalogues unpriced in production.
  it('reads every due release across a batch that would have exceeded the old cap of 100', async () => {
    setUpBandcamp(40);
    mocks.safeFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/album/') ? ok(detailPage(), url) : ok(gridPage(40), url))
    );

    const response = await runHandler({ artistIds: artistIds(3), trigger: 'scheduled' });

    expect(response.statusCode).toBe(200);
    expect(detailFetchCount()).toBe(120);
    // Not merely "more than 100": every artist got a full pass, including the last one.
    expect(mocks.persistReleaseDetail).toHaveBeenCalledTimes(120);
    expect(logs.filter(l => l.includes('detail budget spent'))).toEqual([]);
  });

  // The deadline is the intended stopping condition, so it has to actually fire. Given a slow
  // upstream, the pass must run out of time long before it runs out of count — and say so.
  it('stops on the deadline when the upstream is slow, and names it', async () => {
    setUpBandcamp(40);
    // 5s per release page. With the 1s spacing that is 6s a fetch, so the 9-minute deadline
    // allows roughly 90 — far short of both the 1,000 due and the 300-fetch backstop.
    mocks.safeFetch.mockImplementation(async (url: string) => {
      if (!url.includes('/album/')) return ok(gridPage(40), url);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      return ok(detailPage(), url);
    });

    await runHandler({ artistIds: artistIds(25), trigger: 'scheduled' });

    const stopped = logs.filter(l => l.includes('detail budget spent'));
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.every(l => l.includes('(deadline)'))).toBe(true);
    expect(detailFetchCount()).toBeLessThan(300);
  });

  // The backstop still exists. It is deliberately above what the deadline permits at real
  // response times, so this only fires when the upstream answers instantly — but "high" must not
  // have become "absent", or a pathologically fast run would be unbounded.
  it('still refuses to exceed 300 fetches in one invocation', async () => {
    setUpBandcamp(40);
    mocks.safeFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/album/') ? ok(detailPage(), url) : ok(gridPage(40), url))
    );

    // 25 artists x 40 releases = 1,000 due, with no latency at all to spend the deadline on.
    await runHandler({ artistIds: artistIds(25), trigger: 'scheduled' });

    expect(detailFetchCount()).toBe(300);
    expect(logs.some(l => l.includes('detail budget spent (run-cap)'))).toBe(true);
  });

  // The fix raised a count and left the rate alone. That distinction is the whole safety
  // argument — these are robots-permitted paths, but ~1 request/second is a deliberate courtesy
  // and past outages here were self-inflicted by crawling harder than a host wanted.
  it('still paces release-page requests about a second apart', async () => {
    setUpBandcamp(10);
    const at: number[] = [];
    mocks.safeFetch.mockImplementation((url: string) => {
      if (url.includes('/album/')) at.push(Date.now());
      return Promise.resolve(url.includes('/album/') ? ok(detailPage(), url) : ok(gridPage(10), url));
    });

    await runHandler({ artistIds: artistIds(1), trigger: 'scheduled' });

    expect(at.length).toBe(10);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1_000);
  });
});

describe('Faircamp prices have their own allowance', () => {
  /** Faircamp: `count` release links on the homepage, each with or without a purchase page. */
  function setUpFaircamp(count: number, withPurchase: boolean) {
    mocks.claimArtistForCatalog.mockResolvedValue(true);
    mocks.getArtistForCatalog.mockImplementation((id: string) =>
      Promise.resolve({ id, name: `Artist ${id.slice(0, 4)}`, faircampUrl: `https://music.a${id.slice(0, 4)}.example/` })
    );
    mocks.persistFaircampReleases.mockImplementation((artistId: string, releases: { externalUrl: string }[]) =>
      Promise.resolve(
        releases.map((r, i) => ({
          releaseId: `${artistId}-rel-${i}`,
          sourceId: `${artistId}-src-${i}`,
          url: r.externalUrl,
          detailCheckedAt: null,
          curatedFields: [],
        }))
      )
    );
    mocks.persistReleaseDetail.mockResolvedValue(true);

    const home = `<html><body>${Array.from(
      { length: count },
      (_, i) => `<div class="release"><a href="rel-${i + 1}/"><p>Release ${i + 1}</p></a></div>`
    ).join('')}</body></html>`;

    mocks.safeFetch.mockImplementation((url: string) => {
      if (url.includes('/purchase/')) {
        return Promise.resolve(ok('<html><body><span>7.50 EUR</span></body></html>', url));
      }
      if (/\/rel-\d+\/$/.test(url)) {
        const purchase = withPurchase ? `<a href="purchase/tok${url.match(/rel-(\d+)/)?.[1]}/">Buy</a>` : '';
        return Promise.resolve(
          ok(
            `<html><head><meta property="og:title" content="Release" /></head><body>${purchase}</body></html>`,
            url
          )
        );
      }
      return Promise.resolve(ok(home, url));
    });
  }

  const purchaseFetches = () => mocks.safeFetch.mock.calls.filter(c => String(c[0]).includes('/purchase/')).length;
  const releasePageFetches = () => mocks.safeFetch.mock.calls.filter(c => /\/rel-\d+\/$/.test(String(c[0]))).length;

  // The structural fix. Purchase pages used to share the release-page budget and were fetched
  // after it, so prices were last in line for an allowance the release pages had already spent:
  // the two counts could never sum above 150. Now each has its own pool, so they can.
  it('reads prices after the release-page budget is exhausted', async () => {
    setUpFaircamp(30, true);

    // Six artists x (1 homepage + 30 release pages) is 186 release-page fetches against a budget
    // of 150, so that budget genuinely runs out inside this batch.
    await runHandler({ artistIds: artistIds(6), trigger: 'scheduled' });

    expect(releasePageFetches()).toBeGreaterThan(100);
    expect(purchaseFetches()).toBeGreaterThan(0);
    // The decisive assertion: under one shared budget this sum could not exceed 150.
    expect(releasePageFetches() + purchaseFetches()).toBeGreaterThan(150);
    // Each pool still holds its own ceiling.
    expect(releasePageFetches()).toBeLessThanOrEqual(150);
    expect(purchaseFetches()).toBeLessThanOrEqual(120);
  });

  // A free, unlisted or code-unlocked Faircamp release has no purchase page at all, so there is
  // no price to read and never will be. Recording that settled fact is what stops it being filed
  // under "we haven't looked yet" — the conflation that made 73+ of these read as starvation when
  // the catalogue was cross-tabbed. Measured 2026-08-07: whole instances are like this.
  it('records a release with no purchase page as checked, without fetching one', async () => {
    setUpFaircamp(3, false);

    await runHandler({ artistIds: artistIds(1), trigger: 'scheduled' });

    expect(purchaseFetches()).toBe(0);
    expect(mocks.persistReleaseDetail).toHaveBeenCalledTimes(3);
    // No offers and no status: the call exists only to stamp detail_checked_at. Writing a price
    // of zero here would advertise "name your price" terms the artist never set.
    for (const [, detail] of mocks.persistReleaseDetail.mock.calls) {
      expect(detail).toMatchObject({ offers: [], status: null });
    }
  });

  // The other side of that: an unreadable purchase page is *not* a settled fact. It must stay
  // unstamped so a later run retries, which is the "never cache uncertainty" rule this codebase
  // has been bitten by more than any other.
  it('leaves a release unstamped when its purchase page cannot be read', async () => {
    setUpFaircamp(2, true);
    const inner = mocks.safeFetch.getMockImplementation()!;
    mocks.safeFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes('/purchase/')
        ? Promise.resolve({ ok: false, status: 502, url: String(url), text: () => Promise.resolve('') })
        : (inner as (u: string, ...r: unknown[]) => Promise<unknown>)(String(url), ...rest)
    );

    await runHandler({ artistIds: artistIds(1), trigger: 'scheduled' });

    expect(purchaseFetches()).toBe(2);
    expect(mocks.persistReleaseDetail).not.toHaveBeenCalled();
  });
});
