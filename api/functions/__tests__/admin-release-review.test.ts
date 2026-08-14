// The admin release-review endpoint: the human backstop for tier-3 dedup.
//
// What's worth locking: the auth gate holds, actions validate their inputs before touching the
// database, and a merge conflict is reported as a 409 rather than silently discarding a source.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  getReleaseReviewQueue: vi.fn(),
  dismissReleaseReview: vi.fn(),
  mergeReleases: vi.fn(),
  purgeArtistReleaseCaches: vi.fn(),
  /** What the post-merge slug lookup resolves to. Null stands in for "release vanished". */
  mergedArtistSlug: { value: 'sufjan-stevens' as string | null },
}));

vi.mock('../db', () => ({
  // Chainable enough for the one read the merge path makes: resolving the surviving release's
  // artist slug so the CDN purge can name a cache tag.
  getClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: mocks.mergedArtistSlug.value ? { artists: { slug: mocks.mergedArtistSlug.value } } : null,
          }),
        }),
      }),
    }),
  }),
  getReleaseReviewQueue: mocks.getReleaseReviewQueue,
  dismissReleaseReview: mocks.dismissReleaseReview,
  mergeReleases: mocks.mergeReleases,
}));

vi.mock('../purge-cache', () => ({
  purgeArtistReleaseCaches: mocks.purgeArtistReleaseCaches,
}));

vi.mock('../middleware', () => ({
  authenticateAdmin: mocks.authenticateAdmin,
  buildCorsHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn() } }));

const { handler } = await import('../admin-release-review');

const KEEP = '11111111-1111-1111-1111-111111111111';
const DROP = '22222222-2222-2222-2222-222222222222';
const headers = { authorization: 'Bearer admin-token' };

function get() {
  return handler({ httpMethod: 'GET', headers });
}
function post(body: unknown) {
  return handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.authenticateAdmin.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' });
  mocks.getReleaseReviewQueue.mockResolvedValue([]);
  mocks.dismissReleaseReview.mockResolvedValue(true);
  mocks.mergeReleases.mockResolvedValue({ ok: true });
  mocks.mergedArtistSlug.value = 'sufjan-stevens';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('auth', () => {
  it('refuses anyone who is not an admin', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(401);
    expect((await post({ action: 'dismiss', releaseId: KEEP })).statusCode).toBe(401);
  });

  it('handles OPTIONS without requiring auth', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(r.statusCode).toBe(204);
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });
});

describe('GET — the queue', () => {
  it('returns whatever the queue function reports', async () => {
    mocks.getReleaseReviewQueue.mockResolvedValue([{ primary: { id: KEEP }, counterpart: null }]);
    const body = JSON.parse((await get()).body);
    expect(body.pairs).toHaveLength(1);
  });
});

describe('POST — dismiss', () => {
  it('validates releaseId is a UUID', async () => {
    const r = await post({ action: 'dismiss', releaseId: '../../etc/passwd' });
    expect(r.statusCode).toBe(400);
    expect(mocks.dismissReleaseReview).not.toHaveBeenCalled();
  });

  it('dismisses and reports success', async () => {
    const r = await post({ action: 'dismiss', releaseId: KEEP });
    expect(r.statusCode).toBe(200);
    expect(mocks.dismissReleaseReview).toHaveBeenCalledWith(KEEP);
  });

  it('reports a failure as a 500, not a false success', async () => {
    mocks.dismissReleaseReview.mockResolvedValue(false);
    const r = await post({ action: 'dismiss', releaseId: KEEP });
    expect(r.statusCode).toBe(500);
  });
});

describe('POST — merge', () => {
  it('validates both ids are UUIDs', async () => {
    const r = await post({ action: 'merge', keepId: KEEP, dropId: 'nope' });
    expect(r.statusCode).toBe(400);
    expect(mocks.mergeReleases).not.toHaveBeenCalled();
  });

  it('merges and reports success', async () => {
    const r = await post({ action: 'merge', keepId: KEEP, dropId: DROP });
    expect(r.statusCode).toBe(200);
    expect(mocks.mergeReleases).toHaveBeenCalledWith(KEEP, DROP);
  });

  // Release pages are CDN-cached for an hour, so a merge that doesn't purge stays invisible to
  // the public for that long. Before the TTL went up this path had no purge at all and healed
  // itself in five minutes; now the purge is what makes the merge visible.
  it('purges the artist caches so the merge is visible before the TTL expires', async () => {
    await post({ action: 'merge', keepId: KEEP, dropId: DROP });
    expect(mocks.purgeArtistReleaseCaches).toHaveBeenCalledWith('sufjan-stevens');
  });

  it('does not purge when a merge fails', async () => {
    mocks.mergeReleases.mockResolvedValue({ ok: false, error: 'Both releases already have a source on: bandcamp' });
    await post({ action: 'merge', keepId: KEEP, dropId: DROP });
    expect(mocks.purgeArtistReleaseCaches).not.toHaveBeenCalled();
  });

  // A merge that succeeded is still a success even if we can't work out which caches to clear.
  it('still reports success when the artist slug cannot be resolved', async () => {
    mocks.mergedArtistSlug.value = null;
    const r = await post({ action: 'merge', keepId: KEEP, dropId: DROP });
    expect(r.statusCode).toBe(200);
    expect(mocks.purgeArtistReleaseCaches).not.toHaveBeenCalled();
  });

  // A merge conflict (both sides already have a source on the same platform) is a real
  // decision an admin needs to make, not a 500 — the request wasn't malformed, the outcome was
  // ambiguous.
  it('reports a merge conflict as 409 with the reason', async () => {
    mocks.mergeReleases.mockResolvedValue({ ok: false, error: 'Both releases already have a source on: bandcamp' });
    const r = await post({ action: 'merge', keepId: KEEP, dropId: DROP });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('bandcamp');
  });
});

describe('validation', () => {
  it('rejects an unrecognized action', async () => {
    const r = await post({ action: 'delete-everything' });
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
