// @vitest-environment jsdom
// The artist edit page's links and page sections are reordered by dragging a handle (the same
// sortable list as the embed customiser). The rows carry a page-only id for that, which must
// never reach the server.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'tok', user: { id: 'u1' } }, isLoading: false }),
}));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { ArtistEditPage } from 'src/pages/ArtistEditPage';

const artist = {
  name: 'Kid Lightbulbs',
  imageUrl: null,
  platforms: [
    { sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' },
    { sourceId: 'kofi', url: 'https://ko-fi.com/kidlightbulbs' },
    { sourceId: 'other', url: 'https://kidlightbulbs.com', displayName: 'Website' },
  ],
  profile: { bio: 'Hi', showBio: true, linkDividers: [2] },
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/artist-edit/kid-lightbulbs']}>
      <Routes><Route path="/artist-edit/:slug" element={<ArtistEditPage />} /></Routes>
    </MemoryRouter>,
  );

describe('ArtistEditPage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({ slug: 'kid-lightbulbs' }) });
      if (url.startsWith('/api/artist?')) return Promise.resolve({ ok: true, json: () => Promise.resolve(artist) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives every link, divider and page section a drag handle, named for the screen reader', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Move Bandcamp' });
    expect(screen.getByRole('button', { name: 'Move Ko-fi' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move divider' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move Website' })).toBeTruthy();
    for (const section of ['Bio', 'Featured Release', 'Patronage', 'Marketplaces', 'Social']) {
      expect(screen.getByRole('button', { name: `Move ${section}` })).toBeTruthy();
    }
    // The old up/down arrows are gone.
    expect(screen.queryByTitle('Move up')).toBeNull();
    expect(screen.getByText('Show bio on search results')).toBeTruthy();
  });

  it('saves links and dividers in order without the page-only row ids', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Move Bandcamp' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    const body = JSON.parse(String(init.body));
    expect(body.links).toEqual([
      { platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' },
      { platform: 'kofi', url: 'https://ko-fi.com/kidlightbulbs' },
      { platform: 'divider' },
      { platform: 'other', url: 'https://kidlightbulbs.com', displayName: 'Website' },
    ]);
  });

  it('keeps Save, Cancel and the save result in a bar pinned to the bottom of the screen', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Move Bandcamp' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    const bar = save.closest('.sticky')!;
    expect(bar.className).toContain('bottom-0');
    expect(bar.contains(screen.getByRole('link', { name: 'Cancel' }))).toBe(true);

    fireEvent.click(save);
    // By text: the drag-and-drop lists carry their own role="status" live regions.
    const saved = await screen.findByText('Changes saved!');
    expect(saved.getAttribute('role')).toBe('status');
    expect(bar.contains(saved)).toBe(true);
  });
});
