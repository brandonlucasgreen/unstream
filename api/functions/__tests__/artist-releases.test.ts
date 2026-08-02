// The artist-facing release curation endpoint (spec §11).
//
// What's worth locking: ownership is checked before every write (not just that *some* artist is
// owned, but that the specific release ids in the request belong to *this* artist — the
// distinction that stops a claimed artist from hiding/merging someone else's releases), and a
// merge/dismiss/hide of a release you don't own is refused rather than silently no-op'd.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateBearer: vi.fn(),
  resolveOwnedArtist: vi.fn(),
  verifyReleaseOwnership: vi.fn(),
  getArtistReleasesForOwner: vi.fn(),
  setReleaseHidden: vi.fn(),
  updateArtistReleaseFields: vi.fn(),
  addArtistReleaseLink: vi.fn(),
  createArtistRelease: vi.fn(),
  dismissReleaseReview: vi.fn(),
  mergeReleases: vi.fn(),
  setReleaseDisplayOrder: vi.fn(),
  getCatalogState: vi.fn(),
  clearCatalogCooldown: vi.fn(),
  clearReleaseDetailCooldown: vi.fn(),
  cacheDeleteByArtist: vi.fn(),
  triggerCatalogNow: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({}),
  resolveOwnedArtist: mocks.resolveOwnedArtist,
  verifyReleaseOwnership: mocks.verifyReleaseOwnership,
  getArtistReleasesForOwner: mocks.getArtistReleasesForOwner,
  setReleaseHidden: mocks.setReleaseHidden,
  updateArtistReleaseFields: mocks.updateArtistReleaseFields,
  addArtistReleaseLink: mocks.addArtistReleaseLink,
  createArtistRelease: mocks.createArtistRelease,
  dismissReleaseReview: mocks.dismissReleaseReview,
  mergeReleases: mocks.mergeReleases,
  setReleaseDisplayOrder: mocks.setReleaseDisplayOrder,
  getCatalogState: mocks.getCatalogState,
  clearCatalogCooldown: mocks.clearCatalogCooldown,
  clearReleaseDetailCooldown: mocks.clearReleaseDetailCooldown,
}));

// buildCorsHeaders is NOT stubbed to a constant — this endpoint performs writes, and one thing
// worth asserting is that it no longer hands back a wildcard origin. Mirrors the real helper's
// non-API-key behaviour (pin to the canonical origin).
vi.mock('../middleware', () => ({
  authenticateBearer: mocks.authenticateBearer,
  buildCorsHeaders: (origin: string | undefined, apiKeyPresent: boolean) => ({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': apiKeyPresent
      ? '*'
      : origin === 'https://unstream.stream'
        ? origin
        : 'https://unstream.stream',
    Vary: 'Origin',
  }),
}));

vi.mock('../cache', () => ({
  cacheDeleteByArtist: mocks.cacheDeleteByArtist,
}));

vi.mock('../request-catalog', () => ({
  triggerCatalogNow: mocks.triggerCatalogNow,
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  getClientIp: () => '127.0.0.1',
}));

const { handler } = await import('../artist-releases');

const RELEASE_A = '11111111-1111-1111-1111-111111111111';
const RELEASE_B = '22222222-2222-2222-2222-222222222222';
const headers = { authorization: 'Bearer user-token' };
const SLUG = 'kid-lightbulbs';

function get(slug = SLUG) {
  return handler({ httpMethod: 'GET', headers, queryStringParameters: { slug } });
}
function post(body: unknown) {
  return handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.authenticateBearer.mockResolvedValue({ userId: 'u1', email: 'artist@example.com' });
  mocks.resolveOwnedArtist.mockResolvedValue({ ok: true, status: 200, artistId: 'artist-1', artistName: 'Kid Lightbulbs' });
  mocks.verifyReleaseOwnership.mockResolvedValue(true);
  mocks.getArtistReleasesForOwner.mockResolvedValue([]);
  mocks.setReleaseHidden.mockResolvedValue(true);
  mocks.updateArtistReleaseFields.mockResolvedValue(true);
  mocks.addArtistReleaseLink.mockResolvedValue(true);
  mocks.createArtistRelease.mockResolvedValue({ ok: true, releaseId: RELEASE_A });
  mocks.dismissReleaseReview.mockResolvedValue(true);
  mocks.mergeReleases.mockResolvedValue({ ok: true });
  mocks.setReleaseDisplayOrder.mockResolvedValue(true);
  mocks.getCatalogState.mockResolvedValue({ ok: true, state: null });
  mocks.clearCatalogCooldown.mockResolvedValue(undefined);
  mocks.clearReleaseDetailCooldown.mockResolvedValue(undefined);
  mocks.triggerCatalogNow.mockResolvedValue({ ok: true });
});

afterEach(() => vi.clearAllMocks());

describe('auth', () => {
  it('refuses an unauthenticated caller', async () => {
    mocks.authenticateBearer.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(401);
    expect((await post({ action: 'hide', slug: SLUG, releaseId: RELEASE_A })).statusCode).toBe(401);
  });

  it('handles OPTIONS without requiring auth', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(r.statusCode).toBe(204);
    expect(mocks.authenticateBearer).not.toHaveBeenCalled();
  });
});

describe('ownership', () => {
  it('refuses a caller who does not own the profile', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: false, status: 403, error: 'You do not own this profile' });
    const r = await post({ action: 'hide', slug: SLUG, releaseId: RELEASE_A });
    expect(r.statusCode).toBe(403);
    expect(mocks.setReleaseHidden).not.toHaveBeenCalled();
  });

  it('refuses hide/dismiss/merge for a release id that is not this artist\'s', async () => {
    mocks.verifyReleaseOwnership.mockResolvedValue(false);

    const dismiss = await post({ action: 'dismiss', slug: SLUG, releaseId: RELEASE_A });
    expect(dismiss.statusCode).toBe(403);
    expect(mocks.dismissReleaseReview).not.toHaveBeenCalled();

    const merge = await post({ action: 'merge', slug: SLUG, keepId: RELEASE_A, dropId: RELEASE_B });
    expect(merge.statusCode).toBe(403);
    expect(mocks.mergeReleases).not.toHaveBeenCalled();
  });
});

describe('GET — the owner\'s release list', () => {
  it('requires a slug', async () => {
    const r = await handler({ httpMethod: 'GET', headers, queryStringParameters: {} });
    expect(r.statusCode).toBe(400);
  });

  it('returns whatever the query function reports', async () => {
    mocks.getArtistReleasesForOwner.mockResolvedValue([{ id: RELEASE_A, title: 'A Record' }]);
    const body = JSON.parse((await get()).body);
    expect(body.releases).toHaveLength(1);
  });
});

describe('POST — hide/unhide', () => {
  it('validates releaseId is a UUID', async () => {
    const r = await post({ action: 'hide', slug: SLUG, releaseId: 'nope' });
    expect(r.statusCode).toBe(400);
  });

  it('hides and unhides', async () => {
    await post({ action: 'hide', slug: SLUG, releaseId: RELEASE_A });
    expect(mocks.setReleaseHidden).toHaveBeenCalledWith('artist-1', RELEASE_A, true);

    await post({ action: 'unhide', slug: SLUG, releaseId: RELEASE_A });
    expect(mocks.setReleaseHidden).toHaveBeenCalledWith('artist-1', RELEASE_A, false);
  });
});

describe('POST — merge', () => {
  it('sends the exact keepId/dropId through to mergeReleases', async () => {
    const r = await post({ action: 'merge', slug: SLUG, keepId: RELEASE_A, dropId: RELEASE_B });
    expect(r.statusCode).toBe(200);
    expect(mocks.mergeReleases).toHaveBeenCalledWith(RELEASE_A, RELEASE_B);
  });

  it('reports a merge conflict as 409', async () => {
    mocks.mergeReleases.mockResolvedValue({ ok: false, error: 'Both releases already have a source on: bandcamp' });
    const r = await post({ action: 'merge', slug: SLUG, keepId: RELEASE_A, dropId: RELEASE_B });
    expect(r.statusCode).toBe(409);
  });
});

describe('POST — update', () => {
  it('passes through title/date/artwork fields', async () => {
    await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, title: 'New Title' });
    expect(mocks.updateArtistReleaseFields).toHaveBeenCalledWith('artist-1', RELEASE_A, {
      title: 'New Title',
      releaseDate: undefined,
      artworkUrl: undefined,
    });
  });

  it('rejects a non-HTTPS artwork URL', async () => {
    const r = await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, artworkUrl: 'http://example.com/x.jpg' });
    expect(r.statusCode).toBe(400);
    expect(mocks.updateArtistReleaseFields).not.toHaveBeenCalled();
  });
});

describe('POST — addLink', () => {
  it('rejects a non-http(s) url', async () => {
    const r = await post({ action: 'addLink', slug: SLUG, releaseId: RELEASE_A, platform: 'bandcamp', url: 'not a url' });
    expect(r.statusCode).toBe(400);
    expect(mocks.addArtistReleaseLink).not.toHaveBeenCalled();
  });

  it('adds a link', async () => {
    const r = await post({
      action: 'addLink',
      slug: SLUG,
      releaseId: RELEASE_A,
      platform: 'discogs',
      url: 'https://discogs.com/release/1',
    });
    expect(r.statusCode).toBe(200);
    expect(mocks.addArtistReleaseLink).toHaveBeenCalledWith('artist-1', RELEASE_A, 'discogs', 'https://discogs.com/release/1');
  });
});

describe('POST — create', () => {
  it('requires title, platform, and a valid url', async () => {
    const r = await post({ action: 'create', slug: SLUG, title: '', platform: 'bandcamp', url: 'https://x.bandcamp.com' });
    expect(r.statusCode).toBe(400);
    expect(mocks.createArtistRelease).not.toHaveBeenCalled();
  });

  it('creates a release and reports its id', async () => {
    const r = await post({
      action: 'create',
      slug: SLUG,
      title: 'B-Sides',
      releaseType: 'ep',
      platform: 'bandcamp',
      url: 'https://x.bandcamp.com/album/b-sides',
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).releaseId).toBe(RELEASE_A);
  });

  it('reports a creation failure without a false success', async () => {
    mocks.createArtistRelease.mockResolvedValue({ ok: false, error: 'Title needs at least one letter or number' });
    const r = await post({ action: 'create', slug: SLUG, title: '!!!', platform: 'bandcamp', url: 'https://x.bandcamp.com' });
    expect(r.statusCode).toBe(400);
  });
});

describe('POST — reorder', () => {
  const RELEASE_C = '33333333-3333-3333-3333-333333333333';

  it('stores the arrangement exactly as sent', async () => {
    const r = await post({ action: 'reorder', slug: SLUG, releaseIds: [RELEASE_B, RELEASE_A, RELEASE_C] });
    expect(r.statusCode).toBe(200);
    expect(mocks.setReleaseDisplayOrder).toHaveBeenCalledWith('artist-1', [RELEASE_B, RELEASE_A, RELEASE_C]);
  });

  // The same rule every other release-id action follows: owning the profile says nothing about
  // who owns the ids in the body, so an artist can't rearrange (and thereby confirm the
  // existence of) releases that aren't theirs.
  it('refuses ids that are not this artist\'s', async () => {
    mocks.verifyReleaseOwnership.mockResolvedValue(false);
    const r = await post({ action: 'reorder', slug: SLUG, releaseIds: [RELEASE_A, RELEASE_B] });
    expect(r.statusCode).toBe(403);
    expect(mocks.setReleaseDisplayOrder).not.toHaveBeenCalled();
  });

  it.each([[RELEASE_A], [['nope']], [[RELEASE_A, 42]], [[null]], [{}]])(
    'rejects releaseIds that are not all UUIDs (%o)',
    async bad => {
      const r = await post({ action: 'reorder', slug: SLUG, releaseIds: bad });
      expect(r.statusCode).toBe(400);
      expect(mocks.setReleaseDisplayOrder).not.toHaveBeenCalled();
    }
  );

  // A repeated id isn't an arrangement: the last occurrence would win and a release the artist
  // can see would drop out of their order without saying so.
  it('rejects a repeated id', async () => {
    const r = await post({ action: 'reorder', slug: SLUG, releaseIds: [RELEASE_A, RELEASE_A] });
    expect(r.statusCode).toBe(400);
    expect(mocks.setReleaseDisplayOrder).not.toHaveBeenCalled();
  });

  it('rejects an implausibly long arrangement rather than handing it to Postgres', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`);
    const r = await post({ action: 'reorder', slug: SLUG, releaseIds: many });
    expect(r.statusCode).toBe(400);
    expect(mocks.setReleaseDisplayOrder).not.toHaveBeenCalled();
  });

  // Reset is an empty arrangement — the RPC reads that as "clear every position". It must not
  // trip the ownership check, which reports false for an empty id list.
  it('resets to date order with an empty arrangement, without an ownership lookup', async () => {
    const r = await post({ action: 'resetOrder', slug: SLUG });
    expect(r.statusCode).toBe(200);
    expect(mocks.verifyReleaseOwnership).not.toHaveBeenCalled();
    expect(mocks.setReleaseDisplayOrder).toHaveBeenCalledWith('artist-1', []);
  });

  it('purges the artist caches so the public page picks the new order up', async () => {
    await post({ action: 'reorder', slug: SLUG, releaseIds: [RELEASE_A] });
    expect(mocks.cacheDeleteByArtist).toHaveBeenCalledWith('Kid Lightbulbs');
  });
});

// Open to every verified owner — there is no admin gate on this action, only the once-a-day
// ceiling below. Ownership (`resolveOwnedArtist`) is what authorizes it.
describe('POST — catalog (self-serve scan)', () => {
  it('clears the cooldown before queuing, or the button silently does nothing for a week', async () => {
    const r = await post({ action: 'catalog', slug: SLUG });
    expect(r.statusCode).toBe(202);
    expect(mocks.clearCatalogCooldown).toHaveBeenCalledWith('artist-1');
    // Prices only refresh if the sources are reset too — otherwise "Scan my links" re-confirms
    // the release list and leaves every stored price exactly as it was.
    expect(mocks.clearReleaseDetailCooldown).toHaveBeenCalledWith('artist-1');
    expect(mocks.triggerCatalogNow).toHaveBeenCalledWith('artist-1');
  });

  // Ownership is still the security boundary — nobody, admin or not, may catalog a profile that
  // isn't theirs through this endpoint (that's what /api/admin/catalog-artist is for).
  it('still requires ownership', async () => {
    mocks.resolveOwnedArtist.mockResolvedValue({ ok: false, status: 403, error: 'You do not own this profile' });
    const r = await post({ action: 'catalog', slug: SLUG });
    expect(r.statusCode).toBe(403);
    expect(mocks.triggerCatalogNow).not.toHaveBeenCalled();
  });

  // The once-a-day ceiling. Every press is a fresh crawl of this artist's Bandcamp, Discogs and
  // Faircamp pages, so an owner who can press the button repeatedly is an amplifier.
  it('refuses a second scan inside the cooldown, and does not clear anything', async () => {
    mocks.getCatalogState.mockResolvedValue({
      ok: true,
      state: { last_attempted_at: new Date(Date.now() - 3600_000).toISOString(), last_catalogued_at: null, releases_found: null, releases_detailed: null, last_error: null, consecutive_failures: 0 },
    });
    const r = await post({ action: 'catalog', slug: SLUG });
    expect(r.statusCode).toBe(429);
    expect(mocks.triggerCatalogNow).not.toHaveBeenCalled();
    // Clearing the cooldowns is itself a write, and it would let the *next* press through even
    // though this one was refused.
    expect(mocks.clearCatalogCooldown).not.toHaveBeenCalled();
    expect(mocks.clearReleaseDetailCooldown).not.toHaveBeenCalled();
  });

  it('allows a scan once the cooldown has elapsed', async () => {
    mocks.getCatalogState.mockResolvedValue({
      ok: true,
      state: { last_attempted_at: new Date(Date.now() - 25 * 3600_000).toISOString(), last_catalogued_at: null, releases_found: null, releases_detailed: null, last_error: null, consecutive_failures: 0 },
    });
    expect((await post({ action: 'catalog', slug: SLUG })).statusCode).toBe(202);
  });

  // Not knowing whether a scan is allowed is not permission to run one — the same answer
  // claimArtistForCatalog gives itself when it can't read the row.
  it('refuses rather than guessing when the catalog state cannot be read', async () => {
    mocks.getCatalogState.mockResolvedValue({ ok: false, reason: 'Could not read catalog state' });
    const r = await post({ action: 'catalog', slug: SLUG });
    expect(r.statusCode).toBe(503);
    expect(mocks.triggerCatalogNow).not.toHaveBeenCalled();
  });

  // Netlify answers a background invocation with 202 the instant it's queued and discards the
  // handler's response, so a predictable refusal has to surface here or it reaches the UI as a
  // crawl that simply never finishes.
  it('passes a predictable refusal through with its own status and reason', async () => {
    mocks.triggerCatalogNow.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'Cataloging is disabled on this deploy (RELEASE_CATALOG_ENABLED is not set).',
    });
    const r = await post({ action: 'catalog', slug: SLUG });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error).toContain('RELEASE_CATALOG_ENABLED');
  });

  it('does not purge caches — nothing has been written yet', async () => {
    await post({ action: 'catalog', slug: SLUG });
    expect(mocks.cacheDeleteByArtist).not.toHaveBeenCalled();
  });
});

describe('GET — catalog state for the button', () => {
  it('reports the state and a scan that is ready to run', async () => {
    mocks.getCatalogState.mockResolvedValue({
      ok: true,
      state: { last_attempted_at: '2026-07-01T00:00:00Z', last_catalogued_at: '2026-07-01T00:00:00Z', releases_found: 12, releases_detailed: 9, last_error: null, consecutive_failures: 0 },
    });
    const body = JSON.parse((await get()).body);
    expect(body.catalog.state.releases_found).toBe(12);
    expect(body.catalog.stateError).toBeNull();
    expect(body.catalog.nextScanAvailableAt).toBeNull();
  });

  // The page disables its button from this rather than re-deriving the rule, so a scan that
  // would come back 429 reads as "not yet" instead of a button that errors when pressed.
  it('reports when the next scan is due while the cooldown is running', async () => {
    const lastAttempt = new Date(Date.now() - 3600_000);
    mocks.getCatalogState.mockResolvedValue({
      ok: true,
      state: { last_attempted_at: lastAttempt.toISOString(), last_catalogued_at: null, releases_found: null, releases_detailed: null, last_error: null, consecutive_failures: 0 },
    });
    const body = JSON.parse((await get()).body);
    expect(new Date(body.catalog.nextScanAvailableAt).getTime()).toBe(lastAttempt.getTime() + 24 * 3600_000);
  });

  // A failed read must not arrive as a null state — that renders as a confident
  // "Never catalogued" when the truth is "we couldn't ask" — nor as a scan that's ready to go.
  it('reports an unreadable state distinctly from never-catalogued', async () => {
    mocks.getCatalogState.mockResolvedValue({ ok: false, reason: 'Could not read catalog state' });
    const body = JSON.parse((await get()).body);
    expect(body.catalog.state).toBeNull();
    expect(body.catalog.stateError).toBe('Could not read catalog state');
  });
});

describe('CORS', () => {
  // A write endpoint should not advertise itself to every origin. Previously this file
  // hand-rolled `Access-Control-Allow-Origin: '*'`; it now goes through the shared helper.
  it('never returns a wildcard origin for an authenticated write surface', async () => {
    const r = await post({ action: 'hide', slug: SLUG, releaseId: RELEASE_A });
    expect(r.headers['Access-Control-Allow-Origin']).not.toBe('*');
    expect(r.headers['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
  });

  it('answers preflight with the same restricted headers', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(r.statusCode).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).not.toBe('*');
  });
});

describe('input types — a malformed body must not reach the database layer', () => {
  // The declared TS types are compile-time only. Without a runtime guard a non-string title
  // reaches `patch.title.trim()` in db.ts and throws inside an async function with no
  // try/catch, surfacing as a bare 500 instead of a 400.
  it.each([123, {}, [], true])('rejects a non-string title (%o) with a 400', async bad => {
    const r = await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, title: bad });
    expect(r.statusCode).toBe(400);
    expect(mocks.updateArtistReleaseFields).not.toHaveBeenCalled();
  });

  it('rejects an empty or whitespace-only title', async () => {
    for (const bad of ['', '   ']) {
      const r = await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, title: bad });
      expect(r.statusCode).toBe(400);
    }
    expect(mocks.updateArtistReleaseFields).not.toHaveBeenCalled();
  });

  it('rejects an over-long title rather than silently truncating it', async () => {
    const r = await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, title: 'x'.repeat(201) });
    expect(r.statusCode).toBe(400);
  });

  // null is meaningful — it clears the date — so it must still be accepted.
  it('accepts null releaseDate but rejects a non-string one', async () => {
    expect((await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, releaseDate: null })).statusCode).toBe(200);
    expect((await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, releaseDate: 99 })).statusCode).toBe(400);
  });

  it('rejects a non-string artworkUrl', async () => {
    const r = await post({ action: 'update', slug: SLUG, releaseId: RELEASE_A, artworkUrl: 42 });
    expect(r.statusCode).toBe(400);
  });
});

describe('platform allowlist', () => {
  // release_sources.platform is read back as a registry key for the icon, display name and
  // payoutRank ordering — an arbitrary label renders as a generic badge that sorts last.
  it('rejects a platform that is not in the registry', async () => {
    for (const bad of ['not-a-platform', 'javascript', '', 123]) {
      const r = await post({ action: 'addLink', slug: SLUG, releaseId: RELEASE_A, platform: bad, url: 'https://example.com/x' });
      expect(r.statusCode).toBe(400);
    }
    expect(mocks.addArtistReleaseLink).not.toHaveBeenCalled();
  });

  it('accepts a real registry platform', async () => {
    const r = await post({ action: 'addLink', slug: SLUG, releaseId: RELEASE_A, platform: 'bandcamp', url: 'https://x.bandcamp.com/album/y' });
    expect(r.statusCode).toBe(200);
  });

  it('rejects an unknown platform on create too', async () => {
    const r = await post({ action: 'create', slug: SLUG, title: 'Thing', platform: 'made-up', url: 'https://example.com/x' });
    expect(r.statusCode).toBe(400);
    expect(mocks.createArtistRelease).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('rejects an unrecognized action', async () => {
    const r = await post({ action: 'delete-everything', slug: SLUG });
    expect(r.statusCode).toBe(400);
  });

  it('requires a slug on POST', async () => {
    const r = await post({ action: 'hide', releaseId: RELEASE_A });
    expect(r.statusCode).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const r = await handler({ httpMethod: 'POST', headers, body: '{not json' });
    expect(r.statusCode).toBe(400);
  });

  it('rejects methods other than GET/POST/OPTIONS', async () => {
    const r = await handler({ httpMethod: 'DELETE', headers });
    expect(r.statusCode).toBe(405);
  });
});
