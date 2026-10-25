// @vitest-environment jsdom
// Audit 2026-10-25 #7: a network error or 500 on a public collection read "This saved artists list
// is either private or doesn't exist" — a visitor told the list is gone during an outage. Only a
// 404 says that now; anything else is a retryable error.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicSavedArtistsPage } from 'src/pages/PublicSavedArtistsPage';

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/u/fan']}>
      <Routes>
        <Route path="/u/:handle" element={<PublicSavedArtistsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const collection = { owner_display_name: 'Fan', owner_location: null, saved_artists: [], collection: [] };

describe('PublicSavedArtistsPage', () => {
  it('says private-or-missing only for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    renderPage();
    expect(await screen.findByText(/either private or doesn't exist/)).toBeTruthy();
  });

  it('offers a retry on a 500, and retrying loads the collection', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify(collection), { status: 200 })));
    renderPage();

    expect((await screen.findByRole('alert')).textContent).toContain("couldn't load this collection");
    expect(screen.queryByText(/either private or doesn't exist/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("Fan's collection")).toBeTruthy();
  });
});
