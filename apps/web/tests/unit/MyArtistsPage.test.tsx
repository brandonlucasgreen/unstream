// @vitest-environment jsdom
// /my-artists — the artist half of the old /dashboard, on its own page.
//
// The section it renders used to return null when an account had claimed nothing, because
// it sat above a fan's saved artists and collection. On a page of its own that would leave
// a heading over nothing, so the empty state is now the page's usual state and has to say
// how claiming starts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Chrome, not content: both fetch on their own and would add unrelated requests.
vi.mock('../../src/components/Header', () => ({ Header: () => null }));
vi.mock('../../src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
// Whether tips are switched on, asked once for the Tips buttons.
const getTipsAvailable = vi.fn();
vi.mock('../../src/services/tips', () => ({ getTipsAvailable: (...a: unknown[]) => getTipsAvailable(...a) }));
// Per-profile stats are their own request against their own endpoint.
vi.mock('../../src/components/ArtistAnalytics', () => ({ ArtistAnalytics: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MyArtistsPage } from '../../src/pages/MyArtistsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <MyArtistsPage />
    </MemoryRouter>
  );
}

describe('MyArtistsPage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    getTipsAvailable.mockReset();
    getTipsAvailable.mockResolvedValue(false);
    mockUseAuth.mockReturnValue({
      session: { access_token: 'token' },
      isLoading: false,
    });
  });

  afterEach(cleanup);

  it('tells an account that has claimed nothing how to claim', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ profiles: [] }) });

    renderPage();

    expect(await screen.findByText(/haven't claimed an artist profile/i)).toBeTruthy();
    // Claiming starts from a search result — there is no way to reach /claim/:slug without
    // finding the artist first, so the empty state has to point at search.
    expect(screen.getByRole('link', { name: /search for your name/i }).getAttribute('href')).toBe('/');
  });

  it('gives each page the artist manages its own button: Releases always, Tips when tips are on, Promote for the admin', async () => {
    getTipsAvailable.mockResolvedValue(true);
    mockUseAuth.mockReturnValue({ session: { access_token: 'token' }, isLoading: false, isAdmin: true });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ profiles: [{ id: '1', artistId: 'a1', name: 'Honeycrush', slug: 'honeycrush', claimedAt: '2026-01-01' }] }),
    });

    renderPage();

    expect((await screen.findByRole('link', { name: 'Releases' })).getAttribute('href')).toBe('/releases/honeycrush');
    expect((await screen.findByRole('link', { name: 'Tips' })).getAttribute('href')).toBe('/tips/honeycrush');
    expect(screen.getByRole('link', { name: 'Promote' }).getAttribute('href')).toBe('/promote/honeycrush');
  });

  it('hides Tips while tips are off, and Promote from anyone but the admin', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ profiles: [{ id: '1', artistId: 'a1', name: 'Honeycrush', slug: 'honeycrush', claimedAt: '2026-01-01' }] }),
    });

    renderPage();

    await screen.findByRole('link', { name: 'Releases' });
    await waitFor(() => expect(getTipsAvailable).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Tips' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Promote' })).toBeNull();
  });

  it('lists a claimed profile with its edit and view links', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ profiles: [{ id: '1', artistId: 'a1', name: 'Honeycrush', slug: 'honeycrush', claimedAt: '2026-01-01' }] }),
    });

    renderPage();

    expect(await screen.findByText('Honeycrush')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/artist-edit/honeycrush');
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/a/honeycrush');
    expect(screen.queryByText(/haven't claimed an artist profile/i)).toBeNull();
  });

  it('reports a failed load instead of claiming there are no profiles', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    renderPage();

    // The distinction this page has to keep: "the read failed" is not "you have claimed
    // nobody", so the empty state must stay away.
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your artist profiles/i)).toBeTruthy();
    });
    expect(screen.queryByText(/haven't claimed an artist profile/i)).toBeNull();
  });
});
