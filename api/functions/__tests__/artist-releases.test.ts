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
  cacheDeleteByArtist: vi.fn(),
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
}));

vi.mock('../middleware', () => ({
  authenticateBearer: mocks.authenticateBearer,
}));

vi.mock('../cache', () => ({
  cacheDeleteByArtist: mocks.cacheDeleteByArtist,
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
