// Where a signed-in person lands, with no explicit destination asked for: My Artists if they
// have at least one verified artist, otherwise My Collection.
//
// "Verified" needs no separate check — /api/artist-auth's GET already filters to
// `verified_at IS NOT NULL`, so a non-empty `profiles` is the whole question. The tests below
// pin both halves of that, and that nothing short of a real answer sends anyone to My Artists:
// a sign-in must never be blocked by a failing profiles read.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both exports the service uses — a vi.mock factory replaces the whole module, and the real
// one re-surfaces a caught error as a test failure in this node environment.
const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/react', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import { resolveAccountHome, ARTIST_HOME, COLLECTION_HOME } from 'src/services/accountHome';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function answers(status: number, body: unknown) {
  mockFetch.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('resolveAccountHome', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    captureException.mockClear();
    captureMessage.mockClear();
  });

  it('sends an artist with a verified claim to My Artists', async () => {
    answers(200, { profiles: [{ id: '1', slug: 'kid-lightbulbs' }] });

    expect(await resolveAccountHome('token')).toBe(ARTIST_HOME);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/artist-auth');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });

  it('sends a fan with no claim to My Collection', async () => {
    answers(200, { profiles: [] });
    expect(await resolveAccountHome('token')).toBe(COLLECTION_HOME);
  });

  it('treats a missing profiles field as no claim', async () => {
    answers(200, {});
    expect(await resolveAccountHome('token')).toBe(COLLECTION_HOME);
  });

  it('falls back to My Collection on an expired session, quietly', async () => {
    answers(401, { error: 'Not authenticated' });

    expect(await resolveAccountHome('stale')).toBe(COLLECTION_HOME);
    // The page landed on handles a dead session; reporting it here would be noise.
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('falls back to My Collection when the read fails, and says so', async () => {
    answers(500, { error: 'Failed to fetch profiles' });

    expect(await resolveAccountHome('token')).toBe(COLLECTION_HOME);
    // Same call backs /my-artists, so a 500 is worth knowing about rather than silently
    // turning every artist into a fan.
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][0]).toContain('500');
  });

  it('falls back to My Collection when the request never lands', async () => {
    mockFetch.mockRejectedValue(new TypeError('Load failed'));

    expect(await resolveAccountHome('token')).toBe(COLLECTION_HOME);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
