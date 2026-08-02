// The catalog-backed alert path, and the four spec §5 defects it exists to fix.
//
// Each defect below is a real, shipped bug described in
// docs/specs/unstream-releases-v1-scope.md §5 — these lock the fix rather than the plumbing:
//
//   2. an upcoming release could never be alerted on (`daysDiff >= 0` filtered the future out)
//   3. only the latest release per platform was ever seen
//   4. a multi-platform release was collapsed to one platform by a hardcoded priority list
//   7. the notification body named one platform and no price
//
// Defect 1 is client-side (Swift) and lives in apps/mac/UnstreamTests.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '1.2.3.4'),
  isStoredArtistLink: vi.fn(),
  getReleasesForAlerts: vi.fn(),
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));
vi.mock('../db', () => ({
  isStoredArtistLink: mocks.isStoredArtistLink,
  getReleasesForAlerts: mocks.getReleasesForAlerts,
}));

import { handler } from '../check-releases';

function post(body: unknown) {
  return handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

async function check(body: Record<string, unknown> = {}) {
  const r = await post({
    artistName: 'Someone',
    platforms: { bandcamp: 'https://someone.bandcamp.com' },
    ...body,
  });
  return JSON.parse(r.body);
}

function source(platform: string, offers: { price: number | null; currency: string | null; availability: string }[] = []) {
  return { platform, url: `https://${platform}.example/a-record`, offers };
}

function release(over: Record<string, unknown> = {}) {
  return {
    slug: 'a-record',
    title: 'A Record',
    releaseDate: '2026-07-20',
    datePrecision: 'day',
    status: 'released',
    artworkUrl: null,
    sources: [source('bandcamp', [{ price: 8, currency: 'USD', availability: 'available' }])],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.isStoredArtistLink.mockResolvedValue(false);
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, url: 'https://x', text: async () => '<html></html>' });
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('catalog vs live scrape', () => {
  // The distinction this whole endpoint turns on. Getting it backwards either stops alerting
  // for every uncatalogued artist, or re-scrapes Bandcamp for everyone forever.
  it('answers from the catalog without fetching anything', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [release()] });

    const parsed = await check();

    expect(parsed.source).toBe('catalog');
    expect(parsed.releases).toHaveLength(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reports a genuine empty catalog as no releases, still without fetching', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [] });

    const parsed = await check();

    expect(parsed.source).toBe('catalog');
    expect(parsed.release).toBeNull();
    expect(parsed.releases).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // Null means "never catalogued", which is not evidence about releases — so it must scrape.
  it('falls back to a live scrape when the artist has no catalog at all', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue(null);
    mocks.isStoredArtistLink.mockResolvedValue(true);

    const parsed = await check();

    expect(parsed.source).toBe('live');
    expect(mocks.fetch).toHaveBeenCalled();
  });

  // A database failure is also not evidence about releases.
  it('falls back to a live scrape when the catalog read throws', async () => {
    mocks.getReleasesForAlerts.mockRejectedValue(new Error('supabase down'));
    mocks.isStoredArtistLink.mockResolvedValue(true);

    const parsed = await check();

    expect(parsed.source).toBe('live');
    expect(mocks.fetch).toHaveBeenCalled();
  });
});

describe('defect 2 — upcoming releases can be alerted on', () => {
  it('returns a future-dated release and marks it announced', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ releaseDate: '2099-09-01', status: 'announced', title: 'Next Year' })],
    });

    const parsed = await check();

    expect(parsed.releases[0]).toMatchObject({ releaseName: 'Next Year', status: 'announced' });
    expect(parsed.release.releaseName).toBe('Next Year');
  });
});

describe('defect 3 — more than one release survives', () => {
  it('returns every release in the window, not just the newest', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [
        release({ slug: 'newer', title: 'Newer', releaseDate: '2026-07-25' }),
        release({ slug: 'older', title: 'Older', releaseDate: '2026-07-02' }),
      ],
    });

    const parsed = await check();

    expect(parsed.releases.map((r: { releaseName: string }) => r.releaseName)).toEqual(['Newer', 'Older']);
    // The single-release field a shipped client reads still gets the newest.
    expect(parsed.release.releaseName).toBe('Newer');
  });
});

describe('defect 4 — multi-platform releases are not collapsed', () => {
  it('reports every platform a release is on', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [
        release({
          sources: [
            source('discogs', [{ price: 2.64, currency: 'USD', availability: 'available' }]),
            source('bandcamp', [{ price: 8, currency: 'USD', availability: 'available' }]),
          ],
        }),
      ],
    });

    const parsed = await check();

    expect(parsed.releases[0].platforms).toHaveLength(2);
    expect(parsed.releases[0].platforms).toContain('discogs');
    expect(parsed.releases[0].platforms).toContain('bandcamp');
  });

  // Ordering is the guardrail the sourcing spec insists on: a used Discogs copy at $2.64 must
  // never lead over a direct Bandcamp purchase at $8, even though it is cheaper, because
  // Discogs pays the artist nothing.
  it('leads with the artist-paying platform, not the cheapest', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [
        release({
          sources: [
            source('discogs', [{ price: 2.64, currency: 'USD', availability: 'available' }]),
            source('bandcamp', [{ price: 8, currency: 'USD', availability: 'available' }]),
          ],
        }),
      ],
    });

    const parsed = await check();

    expect(parsed.releases[0].platform).toBe('bandcamp');
    expect(parsed.releases[0].platforms[0]).toBe('bandcamp');
  });
});

describe('defect 7 — the alert body has something to say', () => {
  it('carries a price and a payout estimate', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ sources: [source('bandcamp', [{ price: 8, currency: 'USD', availability: 'available' }])] })],
    });

    const parsed = await check();

    expect(parsed.releases[0].offerSummary).toContain('$8');
    expect(parsed.releases[0].offerSummary).toContain('to artist');
  });

  // Zero means name-your-price, never free. Every Kid Lightbulbs release is name-your-price,
  // so this is the common case, not an edge one.
  it('says name-your-price rather than $0', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ sources: [source('bandcamp', [{ price: 0, currency: 'USD', availability: 'available' }])] })],
    });

    const parsed = await check();

    expect(parsed.releases[0].offerSummary).toBe('Name your price');
  });

  it('leaves the summary empty rather than inventing one when there are no offers', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ sources: [source('bandcamp')] })],
    });

    const parsed = await check();

    expect(parsed.releases[0].offerSummary).toBe('');
  });
});

describe('alerts point at the release page', () => {
  // Pillar 3 of the spec: today an alert hands a fan straight to one shop, which hides the
  // payout comparison at the exact moment they are deciding where to buy.
  it('links to the Unstream release page, keeping the platform URL alongside', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [release()] });

    const parsed = await check();

    expect(parsed.release.releaseUrl).toBe('https://unstream.stream/a/someone/a-record');
    expect(parsed.releases[0].platformUrl).toBe('https://bandcamp.example/a-record');
  });

  it('encodes slugs into the release page URL', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'sigur rós',
      releases: [release({ slug: 'ágætis byrjun' })],
    });

    const parsed = await check();

    expect(parsed.release.releaseUrl).toBe(
      'https://unstream.stream/a/sigur%20r%C3%B3s/%C3%A1g%C3%A6tis%20byrjun'
    );
  });
});

describe('releases that cannot be acted on are dropped', () => {
  it('skips a release with no source to buy from', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ sources: [] })],
    });

    const parsed = await check();

    expect(parsed.releases).toEqual([]);
    expect(parsed.release).toBeNull();
  });

  // An undated release says nothing about being new, and grid ingest produces plenty of them.
  it('skips an undated release', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({
      artistSlug: 'someone',
      releases: [release({ releaseDate: null })],
    });

    const parsed = await check();

    expect(parsed.releases).toEqual([]);
  });
});

describe('the lookback window', () => {
  it('defaults to 31 days, matching what shipped clients assume', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [] });
    await check();
    expect(mocks.getReleasesForAlerts).toHaveBeenCalledWith('Someone', 31);
  });

  it('honours a wider window a newer client asks for', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [] });
    await check({ sinceDays: 90 });
    expect(mocks.getReleasesForAlerts).toHaveBeenCalledWith('Someone', 90);
  });

  // Not a way to pull a whole discography out of an alerts endpoint.
  it('caps an absurd window at a year', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [] });
    await check({ sinceDays: 100_000 });
    expect(mocks.getReleasesForAlerts).toHaveBeenCalledWith('Someone', 365);
  });

  it('ignores a nonsense window rather than failing the request', async () => {
    mocks.getReleasesForAlerts.mockResolvedValue({ artistSlug: 'someone', releases: [] });
    await check({ sinceDays: -5 });
    expect(mocks.getReleasesForAlerts).toHaveBeenCalledWith('Someone', 31);

    mocks.getReleasesForAlerts.mockClear();
    await check({ sinceDays: 'lots' });
    expect(mocks.getReleasesForAlerts).toHaveBeenCalledWith('Someone', 31);
  });
});
