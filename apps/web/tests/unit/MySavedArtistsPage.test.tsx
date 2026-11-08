// @vitest-environment jsdom
// /my-saved-artists: the saved list and the release calendar, split out of /my-collection on
// 2026-11-08.
//
// What's worth locking: the calendar stays behind the "has saved somebody" gate (Brandon,
// 2026-10-21 — a feed of nobody carries nothing), and rendering the page mints no feed token.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));
vi.mock('../../src/components/Header', () => ({ Header: () => null }));
vi.mock('../../src/components/Footer', () => ({ Footer: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MySavedArtistsPage } from '../../src/pages/MySavedArtistsPage';

const artist = {
  artistId: 'a1',
  name: 'Kid Lightbulbs',
  slug: 'kid-lightbulbs',
  claimed: true,
  imageUrl: null,
  notes: null,
  supported: false,
};

function auth(savedArtists: unknown[], artistsLoaded = true) {
  mockUseAuth.mockReturnValue({
    session: { access_token: 'token' },
    isLoading: false,
    savedArtists,
    artistsLoaded,
    savedArtistsError: null,
    loadSavedArtists: vi.fn(),
    removeSavedArtist: vi.fn(async () => true),
    saveArtist: vi.fn(async () => true),
    setArtistSupported: vi.fn(async () => {}),
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/my-saved-artists']}>
      <MySavedArtistsPage />
    </MemoryRouter>
  );
}

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

describe('MySavedArtistsPage', () => {
  it('leads with the release calendar once the fan has saved somebody', () => {
    auth([artist]);
    renderPage();

    expect(screen.getByText('Kid Lightbulbs')).toBeTruthy();
    const headings = screen.getAllByRole('heading').map(h => h.textContent?.trim());
    expect(headings.slice(0, 3)).toEqual(['My Saved Artists', 'Release calendar', 'Saved Artists']);
    expect(screen.queryByRole('button', { name: /Turn off my release feed/ })).toBeNull();
    // ReleaseFeedControls asks for a token only when pressed; the page itself fetches nothing.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('offers a fan who has saved nobody only the off switch, after the empty state', () => {
    auth([]);
    renderPage();

    expect(screen.getByText('No saved artists yet.')).toBeTruthy();
    // No way to subscribe (a feed of nobody carries nothing)...
    expect(screen.queryByRole('button', { name: /Create my feed link/ })).toBeNull();
    // ...but a link made earlier outlives the list, so it can still be killed.
    expect(screen.getByRole('button', { name: /Turn off my release feed/ })).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not flash the calendar in while the list is still loading', () => {
    auth([artist], false);
    renderPage();

    expect(screen.queryByRole('heading', { name: 'Release calendar' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn off my release feed/ })).toBeNull();
  });
});
