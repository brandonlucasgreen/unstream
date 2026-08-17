// @vitest-environment jsdom
// The saved-artists block on the dashboard.
//
// What's worth locking is that it has no list of its own. It used to fetch /api/saved-artists
// itself and mutate a local array, so the copy in AuthContext — the one the save buttons on
// search results and artist pages read — went stale the moment you removed somebody here. A
// removal on the dashboard left the heart on a search result filled in for the rest of the
// session. Every mutation below therefore has to go through the context.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SavedArtistsSection } from '../../src/components/SavedArtistsSection';

const ARTIST = {
  artistId: 'kid-lightbulbs',
  name: 'Kid Lightbulbs',
  slug: 'kid-lightbulbs',
  imageUrl: undefined,
  notes: 'saw them live',
  addedAt: '2026-01-01T00:00:00Z',
  claimed: true,
  supported: false,
};

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { access_token: 'token' },
    savedArtists: [ARTIST],
    artistsLoaded: true,
    savedArtistsError: null,
    loadSavedArtists: vi.fn(),
    removeSavedArtist: vi.fn(async () => true),
    saveArtist: vi.fn(async () => true),
    setArtistSupported: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderSection() {
  return render(
    <MemoryRouter>
      <SavedArtistsSection />
    </MemoryRouter>
  );
}

describe('SavedArtistsSection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockUseAuth.mockReturnValue(auth());
  });

  afterEach(cleanup);

  it('renders the context list without fetching one of its own', () => {
    renderSection();

    expect(screen.getByText('Kid Lightbulbs')).not.toBeNull();
    // The whole point: no second copy. The section reads state, it doesn't load it.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks the context to load the list, so the fetch is shared and cached', () => {
    const loadSavedArtists = vi.fn();
    mockUseAuth.mockReturnValue(auth({ loadSavedArtists }));

    renderSection();

    expect(loadSavedArtists).toHaveBeenCalled();
  });

  it('removes through the context rather than posting directly', async () => {
    const removeSavedArtist = vi.fn(async () => true);
    mockUseAuth.mockReturnValue(auth({ removeSavedArtist }));

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));

    await waitFor(() => {
      expect(removeSavedArtist).toHaveBeenCalledWith('kid-lightbulbs');
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('offers Undo only once the removal has actually stuck', async () => {
    mockUseAuth.mockReturnValue(auth());
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).not.toBeNull();
    });
  });

  it('says so instead of offering Undo when the server refused the removal', async () => {
    mockUseAuth.mockReturnValue(auth({ removeSavedArtist: vi.fn(async () => false) }));
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));

    await waitFor(() => {
      expect(screen.getByText(/Failed to remove artist/)).not.toBeNull();
    });
    // A rollback happened, so the row is still there — an Undo would misdescribe it.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('toggles support through the context, and reports a refusal', async () => {
    const setArtistSupported = vi.fn(async () => { throw new Error('nope'); });
    mockUseAuth.mockReturnValue(auth({ setArtistSupported }));

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Support/ }));

    await waitFor(() => {
      expect(setArtistSupported).toHaveBeenCalledWith('kid-lightbulbs', true);
    });
    expect(screen.getByText(/Failed to update support status/)).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('restores the supported mark on Undo, not just the save', async () => {
    const saveArtist = vi.fn(async () => true);
    const setArtistSupported = vi.fn(async () => {});
    mockUseAuth.mockReturnValue(auth({
      savedArtists: [{ ...ARTIST, supported: true }],
      saveArtist,
      setArtistSupported,
    }));

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(saveArtist).toHaveBeenCalledWith('kid-lightbulbs', 'saw them live', 'Kid Lightbulbs', undefined);
    });
    // Supporting an artist is a record of something the fan did; restoring the save without it
    // would drop that silently.
    expect(setArtistSupported).toHaveBeenCalledWith('kid-lightbulbs', true);
  });

  it('shows an error with a retry when the list failed to load, not a skeleton forever', () => {
    // artistsLoaded stays false on failure — on purpose, so an empty list is never presented
    // as "you have saved nobody". Without reading the error that leaves this section
    // shimmering indefinitely, which is what the old page-level error used to catch.
    const loadSavedArtists = vi.fn();
    mockUseAuth.mockReturnValue(auth({
      savedArtists: [],
      artistsLoaded: false,
      savedArtistsError: "Couldn't load your saved artists.",
      loadSavedArtists,
    }));

    renderSection();

    expect(screen.getByText(/Couldn't load your saved artists/)).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/No saved artists yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadSavedArtists).toHaveBeenCalledTimes(2); // once on mount, once on retry
  });

  it('does not blame the supported mark when the restore itself failed', async () => {
    const setArtistSupported = vi.fn(async () => {});
    mockUseAuth.mockReturnValue(auth({
      savedArtists: [{ ...ARTIST, supported: true }],
      saveArtist: vi.fn(async () => false),
      setArtistSupported,
    }));

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't restore Kid Lightbulbs/)).not.toBeNull();
    });
    // The save never landed, so there is no row to mark — attempting it would produce an
    // error message about the mark for a restore that didn't happen.
    expect(setArtistSupported).not.toHaveBeenCalled();
  });

  it('says which half of a restore succeeded when the mark fails', async () => {
    mockUseAuth.mockReturnValue(auth({
      savedArtists: [{ ...ARTIST, supported: true }],
      saveArtist: vi.fn(async () => true),
      setArtistSupported: vi.fn(async () => { throw new Error('nope'); }),
    }));

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kid Lightbulbs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.getByText(/Restored Kid Lightbulbs, but not the supported mark/)).not.toBeNull();
    });
  });

  it('shows a skeleton until the context reports the list loaded', () => {
    mockUseAuth.mockReturnValue(auth({ savedArtists: [], artistsLoaded: false }));
    renderSection();

    expect(screen.getByRole('status')).not.toBeNull();
    // Not the empty state — "no saved artists yet" is a claim we can't make yet.
    expect(screen.queryByText(/No saved artists yet/)).toBeNull();
  });
});
