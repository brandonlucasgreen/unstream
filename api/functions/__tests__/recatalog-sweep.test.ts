// The scheduled sweep endpoint, and the per-artist isolation it depends on.
//
// Two things are being protected here, and both are failure-to-fail-loudly problems:
//
//  1. The sweep must never answer 200 when it did nothing it was asked to do. A daily job that
//     reports success while cataloging is disabled, or the database is unreadable, recreates
//     precisely the bug it was built to fix — release alerts going quiet with nothing to see.
//  2. One artist blowing up mid-sweep must not take the rest of the batch with it. Slots are
//     scarce — a few dozen a day against a pool in the thousands — so the artists after a
//     failure would wait a whole rotation for a place they only reached by being the stalest.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStaleCatalogCandidates: vi.fn(),
  requestArtistCatalog: vi.fn(),
  captureMessage: vi.fn(),
  // For the background-loop isolation test:
  claimArtistForCatalog: vi.fn(),
  getArtistForCatalog: vi.fn(),
  recordCatalogOutcome: vi.fn(),
}));

vi.mock('../db', () => ({
  getStaleCatalogCandidates: mocks.getStaleCatalogCandidates,
  claimArtistForCatalog: mocks.claimArtistForCatalog,
  getArtistForCatalog: mocks.getArtistForCatalog,
  recordCatalogOutcome: mocks.recordCatalogOutcome,
  persistReleases: vi.fn(),
  persistDiscogsReleases: vi.fn(),
  persistFaircampReleases: vi.fn(),
  persistJamcoopReleases: vi.fn(),
  persistMusicBrainzEnrichment: vi.fn(),
  persistReleaseDetail: vi.fn(),
  attachDiscoveredSource: vi.fn(),
}));

vi.mock('../request-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../request-catalog')>();
  return { ...actual, requestArtistCatalog: mocks.requestArtistCatalog };
});

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: vi.fn() },
  initSentry: vi.fn(),
  isSentryInitialized: () => false,
}));

const { handler } = await import('../recatalog-sweep');

const SECRET = 'sweep-test-secret';
const originalEnv = { ...process.env };

function candidate(artistId: string, lastAttemptedAt: string | null = '2026-07-01T00:00:00+00:00') {
  return { artistId, saved: false, savers: 0, lastAttemptedAt, releasesFound: 12 };
}

function selection(candidates: ReturnType<typeof candidate>[], extra: Record<string, number> = {}) {
  return {
    ok: true,
    candidates,
    catalogueable: 2_500,
    savedArtists: 9,
    inCooldown: 2_400,
    eligible: 100,
    ...extra,
  };
}

function post(headers: Record<string, string | undefined> = { authorization: `Bearer ${SECRET}` }) {
  return handler({ httpMethod: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_FUNCTION_SECRET = SECRET;
  process.env.RELEASE_CATALOG_ENABLED = 'true';
  process.env.URL = 'https://unstream.stream';
  mocks.requestArtistCatalog.mockResolvedValue(true);
  mocks.getStaleCatalogCandidates.mockResolvedValue(selection([candidate('a'), candidate('b')]));
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('recatalog-sweep auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const r = await post({});
    expect(r.statusCode).toBe(401);
    expect(mocks.getStaleCatalogCandidates).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const r = await post({ authorization: 'Bearer not-the-secret' });
    expect(r.statusCode).toBe(401);
  });

  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  it('rejects a secret of a different length without throwing', async () => {
    const r = await post({ authorization: 'Bearer x' });
    expect(r.statusCode).toBe(401);
  });

  // Fail closed: an unconfigured secret closes the endpoint, it does not open it. This one
  // makes Unstream crawl third-party sites on request.
  it('rejects everything when no secret is configured', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    const r = await post({ authorization: 'Bearer anything' });
    expect(r.statusCode).toBe(401);
  });

  it('rejects non-POST', async () => {
    const r = await handler({ httpMethod: 'GET', headers: { authorization: `Bearer ${SECRET}` } });
    expect(r.statusCode).toBe(405);
    expect(mocks.getStaleCatalogCandidates).not.toHaveBeenCalled();
  });
});

describe('recatalog-sweep refuses out loud', () => {
  it('fails, rather than quietly succeeding, when cataloging is disabled', async () => {
    delete process.env.RELEASE_CATALOG_ENABLED;

    const r = await post();

    // 503 fails the GitHub Actions run. A 200 here would mean a sweep that can never do
    // anything reports success every morning forever.
    expect(r.statusCode).toBe(503);
    expect(mocks.requestArtistCatalog).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
      expect.objectContaining({ tags: expect.objectContaining({ kind: 'sweep-disabled' }) })
    );
  });

  it('fails when the candidates cannot be read', async () => {
    mocks.getStaleCatalogCandidates.mockResolvedValue({ ok: false, reason: 'Could not read saved artists: down' });

    const r = await post();

    expect(r.statusCode).toBe(503);
    expect(mocks.requestArtistCatalog).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ kind: 'sweep-selection-failed' }) })
    );
  });

  it('fails when the request to the cataloging function never leaves', async () => {
    mocks.requestArtistCatalog.mockResolvedValue(false);

    const r = await post();

    // A completed handshake proves little — the dispatcher 202s anything — but a failed one
    // proves the sweep did nothing, and for a once-a-day job there is no next caller to retry.
    expect(r.statusCode).toBe(502);
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ kind: 'sweep-dispatch-failed' }) })
    );
  });
});

describe('recatalog-sweep dispatch', () => {
  it('asks for the selected artists under the scheduled trigger', async () => {
    const r = await post();

    expect(r.statusCode).toBe(200);
    // 'scheduled' has its own hourly ceiling, above search and below saving, and is what makes
    // the sweep visible in release_catalog_state.last_trigger.
    expect(mocks.requestArtistCatalog).toHaveBeenCalledWith(['a', 'b'], 'scheduled');
  });

  it('asks for one background invocation worth of artists', async () => {
    await post();
    // Matches MAX_ARTISTS_PER_RUN in catalog-artist-background: asking for more would silently
    // drop the overflow, which would look like the sweep working.
    expect(mocks.getStaleCatalogCandidates).toHaveBeenCalledWith(25);
  });

  it('reports counts a reader can tell a quiet run from a broken sweep by', async () => {
    const savedOne = { ...candidate('a', null), saved: true, savers: 3 };
    mocks.getStaleCatalogCandidates.mockResolvedValue(
      selection([savedOne, candidate('b', '2026-06-01T00:00:00+00:00')])
    );

    const r = await post();

    // `catalogueable` is the load-bearing one: requested: 0 is fine when inCooldown accounts
    // for the pool, and alarming when the pool itself has collapsed. Without it in the body
    // those two are indistinguishable from the workflow log.
    expect(JSON.parse(r.body)).toEqual({
      requested: 2,
      catalogueable: 2_500,
      savedArtists: 9,
      inCooldown: 2_400,
      eligible: 100,
      savedInBatch: 1,
      neverAttempted: 1,
      stalestAttemptedAt: null,
    });
  });

  it('is a quiet success when everyone is inside their cooldown', async () => {
    mocks.getStaleCatalogCandidates.mockResolvedValue(
      selection([], { inCooldown: 2_500, eligible: 0 })
    );

    const r = await post();

    // Nothing to do is a real, correct outcome — every saved artist was catalogued this week.
    expect(r.statusCode).toBe(200);
    expect(mocks.requestArtistCatalog).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).requested).toBe(0);
  });
});

describe('one artist failing does not abort the sweep', () => {
  // The sweep's per-artist work happens inside catalog-artist-background, one artist at a time.
  // Exercised through the real handler: what matters is that the artists *after* a thrown
  // failure are still catalogued, and that the failure is recorded against the one that caused
  // it rather than lost.
  it('catalogs the rest of the batch and records the failure', async () => {
    const { handler: catalogHandler } = await import('../catalog-artist-background');

    mocks.claimArtistForCatalog.mockResolvedValue(true);
    mocks.getArtistForCatalog.mockImplementation(async (artistId: string) => {
      if (artistId === 'boom') throw new Error('supabase exploded');
      return { id: artistId, name: artistId, bandcampUrl: null, discogsUrl: null, faircampUrl: null, jamcoopUrl: null };
    });

    const result = await catalogHandler({
      httpMethod: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ artistIds: ['before', 'boom', 'after'], trigger: 'scheduled' }),
    });

    expect(result.statusCode).toBe(200);
    // All three were attempted — the throw did not unwind the loop.
    expect(mocks.getArtistForCatalog.mock.calls.map(c => c[0])).toEqual(['before', 'boom', 'after']);
    expect(mocks.recordCatalogOutcome).toHaveBeenCalledWith('boom', { error: 'supabase exploded' });
  }, 15_000);

  it('spends the scheduled budget, not the search budget', async () => {
    const { handler: catalogHandler } = await import('../catalog-artist-background');
    mocks.claimArtistForCatalog.mockResolvedValue(false);

    await catalogHandler({
      httpMethod: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ artistIds: ['a'], trigger: 'scheduled' }),
    });

    // Before this feature the trigger was parsed as `=== 'saved' ? 'saved' : 'searched'`, so a
    // scheduled sweep would silently have spent the smallest budget.
    expect(mocks.claimArtistForCatalog).toHaveBeenCalledWith('a', 'scheduled');
  });
});
