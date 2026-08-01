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

function setupFetchMock(releases: unknown[], catalog?: unknown) {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      // GET
      return Promise.resolve({ ok: true, json: async () => ({ releases, catalog }) });
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

  // Adding a link is the action most likely to be typed slightly wrong, and it used to fail
  // invisibly: the server rejects a scheme-less URL, and the only report of that was a banner
  // above the whole release list, off-screen from the form.
  it('adds a link, sending a scheme-less address as https', async () => {
    setupFetchMock([releaseItem()]);
    renderPage();

    await waitFor(() => screen.getByText('Edit / add link'));
    fireEvent.click(screen.getByText('Edit / add link'));

    const urlInputs = screen.getAllByPlaceholderText('https://...');
    fireEvent.change(urlInputs[urlInputs.length - 1], {
      target: { value: 'subvert.fm/kid-lightbulbs/infinite-normal' },
    });
    fireEvent.click(screen.getByText('Add link'));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      expect(body.action).toBe('addLink');
      expect(body.url).toBe('https://subvert.fm/kid-lightbulbs/infinite-normal');
    });
    await waitFor(() => expect(screen.getByText('Link added.')).toBeTruthy());
  });

  it('reports a rejected link beside the field and keeps what was typed', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return Promise.resolve({ ok: true, json: async () => ({ releases: [releaseItem()] }) });
      }
      return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'Unknown platform' }) });
    });
    renderPage();

    await waitFor(() => screen.getByText('Edit / add link'));
    fireEvent.click(screen.getByText('Edit / add link'));

    const urlInputs = screen.getAllByPlaceholderText('https://...') as HTMLInputElement[];
    const urlInput = urlInputs[urlInputs.length - 1];
    fireEvent.change(urlInput, { target: { value: 'https://subvert.fm/a/b' } });
    fireEvent.click(screen.getByText('Add link'));

    await waitFor(() => expect(screen.getByText(/Couldn't add that link/)).toBeTruthy());
    expect(urlInput.value).toBe('https://subvert.fm/a/b');
  });

  it('shows an empty state when there is nothing catalogued', async () => {
    setupFetchMock([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No releases catalogued yet.')).toBeTruthy());
  });
});

describe('ArtistReleasesPage — self-serve catalog scan', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  const SCAN_LABEL = 'Scan my links for releases';

  // Visibility follows the server's `canTrigger`, not a copy of the rule in page code — so the
  // rollout gate can't drift out of sync with the client.
  it('hides the scan control when the server says the caller cannot trigger', async () => {
    setupFetchMock([], { canTrigger: false, state: null, stateError: null });
    renderPage();
    await waitFor(() => screen.getByText('No releases catalogued yet.'));
    expect(screen.queryByText(SCAN_LABEL)).toBeNull();
  });

  it('hides the scan control entirely when the response carries no catalog block at all', async () => {
    setupFetchMock([]);
    renderPage();
    await waitFor(() => screen.getByText('No releases catalogued yet.'));
    expect(screen.queryByText(SCAN_LABEL)).toBeNull();
  });

  it('shows the scan control, and says it is admin-only for now', async () => {
    setupFetchMock([], { canTrigger: true, state: null, stateError: null });
    renderPage();
    await waitFor(() => expect(screen.getByText(SCAN_LABEL)).toBeTruthy());
    expect(screen.getByText(/Admin only for now/)).toBeTruthy();
    expect(screen.getByText('Never catalogued')).toBeTruthy();
  });

  it('summarizes a previous run', async () => {
    setupFetchMock([], {
      canTrigger: true,
      state: { last_catalogued_at: '2026-08-01T00:00:00Z', releases_found: 12, releases_detailed: 9, last_error: null },
      stateError: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('12 releases found, 9 with prices')).toBeTruthy());
  });

  // "We couldn't ask" must not render as a confident "Never catalogued".
  it('reports an unreadable state instead of claiming never-catalogued', async () => {
    setupFetchMock([], { canTrigger: true, state: null, stateError: 'Could not read catalog state' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Could not read catalog state')).toBeTruthy());
    expect(screen.queryByText('Never catalogued')).toBeNull();
  });

  it('reports a failed previous run rather than a count', async () => {
    setupFetchMock([], {
      canTrigger: true,
      state: { last_catalogued_at: '2026-08-01T00:00:00Z', releases_found: 0, releases_detailed: 0, last_error: 'bandcamp bot challenge' },
      stateError: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Last run failed: bandcamp bot challenge/)).toBeTruthy());
  });

  it('posts the catalog action for this artist when clicked', async () => {
    setupFetchMock([], { canTrigger: true, state: null, stateError: null });
    renderPage();
    await waitFor(() => screen.getByText(SCAN_LABEL));

    fireEvent.click(screen.getByText(SCAN_LABEL));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall![1].body)).toEqual({ slug: 'kid-lightbulbs', action: 'catalog' });
    });
  });

  // The endpoint reports refusals it can predict (cataloging disabled, missing secret) as real
  // errors; those must surface rather than leaving the UI stuck on "Scanning…".
  it('surfaces a refusal from the endpoint', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ releases: [], catalog: { canTrigger: true, state: null, stateError: null } }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Cataloging is disabled on this deploy (RELEASE_CATALOG_ENABLED is not set).' }),
      });
    });

    renderPage();
    await waitFor(() => screen.getByText(SCAN_LABEL));
    fireEvent.click(screen.getByText(SCAN_LABEL));

    await waitFor(() => expect(screen.getByText(/RELEASE_CATALOG_ENABLED/)).toBeTruthy());
    // Re-enabled rather than stuck mid-scan, so it can be retried once configuration is fixed.
    expect((screen.getByText(SCAN_LABEL) as HTMLButtonElement).disabled).toBe(false);
  });
});
