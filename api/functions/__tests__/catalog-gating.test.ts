// The two gates on release cataloging: a shared secret, and production-only.
//
// Both matter because this is the code that writes to the production database and issues
// outbound crawls. Deploy previews run against production Supabase, so an ungated preview
// would write real releases and spend the real hourly crawl budget on traffic that isn't real.
//
// Every check here is expected to fail *closed* — the recurring mistake in this area is a
// guard that quietly permits when its input is missing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimArtistForCatalog: vi.fn(),
  getArtistForCatalog: vi.fn(),
  persistReleases: vi.fn(),
  persistDiscogsReleases: vi.fn(),
  persistMusicBrainzEnrichment: vi.fn(),
  recordCatalogOutcome: vi.fn(),
  safeFetch: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../db', () => ({
  claimArtistForCatalog: mocks.claimArtistForCatalog,
  getArtistForCatalog: mocks.getArtistForCatalog,
  persistReleases: mocks.persistReleases,
  persistDiscogsReleases: mocks.persistDiscogsReleases,
  persistMusicBrainzEnrichment: mocks.persistMusicBrainzEnrichment,
  recordCatalogOutcome: mocks.recordCatalogOutcome,
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

import { handler } from '../catalog-artist-background';
import { requestArtistCatalog } from '../request-catalog';

const SECRET = 'test-secret-value';
const ARTIST = '11111111-1111-1111-1111-111111111111';

function post(headers: Record<string, string | undefined>, body: unknown) {
  return handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_FUNCTION_SECRET = SECRET;
  process.env.RELEASE_CATALOG_ENABLED = 'true';
  process.env.URL = 'https://unstream.stream';
  mocks.claimArtistForCatalog.mockResolvedValue(false); // don't do real work by default
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('catalog-artist-background auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const r = await post({}, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(401);
    expect(mocks.claimArtistForCatalog).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const r = await post({ authorization: 'Bearer wrong-value-x' }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(401);
  });

  // A wrong-length secret must not crash — timingSafeEqual throws on length mismatch, so the
  // lengths are compared first.
  it('rejects a secret of a different length without throwing', async () => {
    const r = await post({ authorization: 'Bearer short' }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(401);
  });

  // Fail closed: an unconfigured secret closes the endpoint, it does not open it.
  it('rejects everything when no secret is configured', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    const r = await post({ authorization: 'Bearer anything' }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(401);
  });

  it('accepts the correct secret', async () => {
    const r = await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(200);
  });

  it('rejects non-POST', async () => {
    const r = await handler({ httpMethod: 'GET', headers: {} });
    expect(r.statusCode).toBe(405);
  });
});

describe('catalog-artist-background refuses where cataloging is disabled', () => {
  // Checked at the writer as well as the caller: the caller-side gate stops a preview asking,
  // this one holds the guarantee no matter who asks, since this is what writes to production.
  it('refuses when RELEASE_CATALOG_ENABLED is unset', async () => {
    delete process.env.RELEASE_CATALOG_ENABLED;

    const r = await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [ARTIST] });

    expect(r.statusCode).toBe(403);
    expect(mocks.claimArtistForCatalog).not.toHaveBeenCalled();
  });

  it.each(['false', 'yes', ''])('refuses when the flag is %o', async value => {
    process.env.RELEASE_CATALOG_ENABLED = value;
    const r = await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(403);
  });

  it('proceeds when enabled', async () => {
    const r = await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [ARTIST] });
    expect(r.statusCode).toBe(200);
    expect(mocks.claimArtistForCatalog).toHaveBeenCalledWith(ARTIST, 'searched');
  });

  it('caps how many artists one invocation may name', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `${i}`.padStart(8, '0') + '-1111-1111-1111-111111111111');
    await post({ authorization: `Bearer ${SECRET}` }, { artistIds: many, trigger: 'saved' });
    expect(mocks.claimArtistForCatalog.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it('rejects an empty or malformed artistIds list', async () => {
    expect((await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [] })).statusCode).toBe(400);
    expect((await post({ authorization: `Bearer ${SECRET}` }, { artistIds: 'nope' })).statusCode).toBe(400);
    expect((await post({ authorization: `Bearer ${SECRET}` }, {})).statusCode).toBe(400);
  });

  it('defaults an unrecognized trigger to searched, the smaller budget', async () => {
    await post({ authorization: `Bearer ${SECRET}` }, { artistIds: [ARTIST], trigger: 'nonsense' });
    expect(mocks.claimArtistForCatalog).toHaveBeenCalledWith(ARTIST, 'searched');
  });
});

describe('requestArtistCatalog only runs where cataloging is enabled', () => {
  // The gate this replaced tested `CONTEXT !== 'production'`, which is unimplementable:
  // Netlify exposes only URL, SITE_NAME and SITE_ID to a function at runtime, so CONTEXT is
  // undefined in every deployed function and the check refused everything, in production,
  // always. The test passed the whole time because it set CONTEXT itself.
  it('makes no request when RELEASE_CATALOG_ENABLED is unset', async () => {
    delete process.env.RELEASE_CATALOG_ENABLED;
    await requestArtistCatalog([ARTIST], 'saved');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // Unset means off, and so does anything that isn't exactly 'true' — a crawl budget that fails
  // open is worse than one that fails closed.
  it.each(['false', '1', 'yes', ''])('makes no request when the flag is %o', async value => {
    process.env.RELEASE_CATALOG_ENABLED = value;
    await requestArtistCatalog([ARTIST], 'saved');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('makes no request when the secret is missing', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    await requestArtistCatalog([ARTIST], 'saved');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('requests in production, with the secret and the trigger', async () => {
    mocks.fetch.mockResolvedValue({ status: 202, ok: true } as Response);

    await requestArtistCatalog([ARTIST], 'saved');

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(String(url)).toContain('/.netlify/functions/catalog-artist-background');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      artistIds: [ARTIST],
      trigger: 'saved',
    });
  });

  it('deduplicates ids and never throws when the handshake fails', async () => {
    mocks.fetch.mockRejectedValue(new Error('network down'));

    await expect(requestArtistCatalog([ARTIST, ARTIST, ''], 'searched')).resolves.toBeUndefined();

    const body = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body));
    expect(body.artistIds).toEqual([ARTIST]);
  });

  it('does nothing for an empty list', async () => {
    await requestArtistCatalog([], 'saved');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
