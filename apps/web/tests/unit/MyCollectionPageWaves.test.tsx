// @vitest-environment jsdom
// /my-collection's request timing.
//
// Its predecessor /dashboard held one `loading` flag covering /api/artist-auth,
// /api/saved-artists and /api/me/recent-releases, and rendered nothing until the slowest
// settled. CollectionSection only mounted after that, so the collection read — the heaviest
// on the page — didn't start until the others had finished: requests in two serial waves,
// with no data dependency justifying the second.
//
// This pins the fix. Nothing here asserts on milliseconds; it asserts that a section's
// request is in flight while another section's is still unresolved, which is the property
// that a page-level loading gate destroys.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Chrome, not content: both fetch on their own and would add unrelated requests.
vi.mock('../../src/components/Header', () => ({ Header: () => null }));
vi.mock('../../src/components/Footer', () => ({ Footer: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MyCollectionPage } from '../../src/pages/MyCollectionPage';

/** A request that never answers, standing in for a slow endpoint. */
function pending() {
  return new Promise<never>(() => {});
}

function urlsRequested(): string[] {
  return mockFetch.mock.calls.map(call => String(call[0]));
}

describe('MyCollectionPage request waves', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockUseAuth.mockReturnValue({
      session: { access_token: 'token' },
      isLoading: false,
      savedArtists: [],
      artistsLoaded: true,
      loadSavedArtists: vi.fn(),
      removeSavedArtist: vi.fn(async () => true),
      saveArtist: vi.fn(async () => {}),
      setArtistSupported: vi.fn(async () => {}),
    });
  });

  afterEach(cleanup);

  it('starts the collection read without waiting for the other sections', async () => {
    // Everything except the collection hangs forever. Under the old page-level gate the
    // collection request was never even made in this situation.
    mockFetch.mockImplementation((url: string) =>
      String(url).startsWith('/api/me/collection')
        ? Promise.resolve({ ok: true, json: async () => ({ items: [], total: 0 }) })
        : pending()
    );

    render(
      <MemoryRouter>
        <MyCollectionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(urlsRequested()).toContain('/api/me/collection');
    });
    // And the one it isn't waiting for went out too — concurrently, not instead.
    expect(urlsRequested()).toContain('/api/me/recent-releases');
  });

  it('does not fetch the saved-artists list itself', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => ({ items: [], total: 0 }) })
    );

    render(
      <MemoryRouter>
        <MyCollectionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(urlsRequested()).toContain('/api/me/collection');
    });
    // The list comes from AuthContext, which loads it once per session and shares it with the
    // save buttons on search results. A second copy here is the bug this replaced.
    expect(urlsRequested().some(url => url.startsWith('/api/saved-artists'))).toBe(false);
  });

  it('leaves the claimed-artist read to /my-artists', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => ({ items: [], total: 0 }) })
    );

    render(
      <MemoryRouter>
        <MyCollectionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(urlsRequested()).toContain('/api/me/collection');
    });
    expect(urlsRequested()).not.toContain('/api/artist-auth');
  });
});
