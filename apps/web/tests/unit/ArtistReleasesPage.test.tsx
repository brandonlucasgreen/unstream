// @vitest-environment jsdom
// The artist-facing release curation page (spec §11).
//
// What's worth locking: the merge button on a flagged pair sends the *current* release as
// keepId and its flagged counterpart as dropId (never swapped — that would merge away the
// release the artist is looking at), and the add-release form actually reaches the network
// with the fields the artist typed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ArtistReleasesPage } from 'src/pages/ArtistReleasesPage';

const mockSession = { access_token: 'user-token' };
vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: mockSession }),
}));

vi.mock('src/components/Header', () => ({
  Header: () => null,
}));

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function releaseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Ruined Castle',
    slug: 'ruined-castle',
    releaseType: 'album',
    releaseDate: '2024-06-01',
    datePrecision: 'day',
    artworkUrl: null,
    isHidden: false,
    needsReview: false,
    flaggedAgainst: null,
    sources: [{ platform: 'bandcamp', url: 'https://x.bandcamp.com/album/ruined-castle' }],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/artist-edit/kid-lightbulbs/releases']}>
      <Routes>
        <Route path="/artist-edit/:slug/releases" element={<ArtistReleasesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function setupFetchMock(releases: unknown[]) {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      // GET
      return Promise.resolve({ ok: true, json: async () => ({ releases }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
  });
}

describe('ArtistReleasesPage', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('lists releases fetched for this artist', async () => {
    setupFetchMock([releaseItem()]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Ruined Castle')).toBeTruthy());
  });

  it('shows a needs-review release with its flagged counterpart', async () => {
    setupFetchMock([
      releaseItem({
        id: '11111111-1111-1111-1111-111111111111',
        needsReview: true,
        flaggedAgainst: { id: '22222222-2222-2222-2222-222222222222', title: 'Ruined Castle (Deluxe)' },
      }),
    ]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Possible duplicate of/)).toBeTruthy();
      expect(screen.getByText('Ruined Castle (Deluxe)')).toBeTruthy();
    });
  });

  // The one bug that would matter: the merge call must keep the release being viewed, not
  // swap in its counterpart as the survivor.
  it('merges keeping the current release, dropping its flagged counterpart', async () => {
    setupFetchMock([
      releaseItem({
        id: '11111111-1111-1111-1111-111111111111',
        needsReview: true,
        flaggedAgainst: { id: '22222222-2222-2222-2222-222222222222', title: 'Ruined Castle (Deluxe)' },
      }),
    ]);
    renderPage();

    await waitFor(() => screen.getByText('Same release — keep this one'));
    fireEvent.click(screen.getByText('Same release — keep this one'));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      expect(body).toMatchObject({
        action: 'merge',
        keepId: '11111111-1111-1111-1111-111111111111',
        dropId: '22222222-2222-2222-2222-222222222222',
      });
    });
  });

  it('toggles hide/unhide with the right release id', async () => {
    setupFetchMock([releaseItem()]);
    renderPage();

    await waitFor(() => screen.getByText('Hide'));
    fireEvent.click(screen.getByText('Hide'));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall![1].body)).toMatchObject({
        action: 'hide',
        releaseId: '11111111-1111-1111-1111-111111111111',
      });
    });
  });

  it('submits the add-release form with the typed fields', async () => {
    setupFetchMock([]);
    renderPage();

    await waitFor(() => screen.getByText('+ Add a release we missed'));
    fireEvent.click(screen.getByText('+ Add a release we missed'));

    fireEvent.change(screen.getByPlaceholderText('Release title'), { target: { value: 'A New EP' } });
    const urlInputs = screen.getAllByPlaceholderText('https://...');
    fireEvent.change(urlInputs[urlInputs.length - 1], { target: { value: 'https://x.bandcamp.com/album/new-ep' } });

    fireEvent.click(screen.getByText('Add release'));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      expect(body.action).toBe('create');
      expect(body.title).toBe('A New EP');
      expect(body.url).toBe('https://x.bandcamp.com/album/new-ep');
    });
  });

  it('shows an empty state when there is nothing catalogued', async () => {
    setupFetchMock([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No releases catalogued yet.')).toBeTruthy());
  });
});
