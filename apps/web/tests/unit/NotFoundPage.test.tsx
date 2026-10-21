// @vitest-environment jsdom
// The catch-all page.
//
// Before it, an unmatched path rendered an empty #root: a white page with no heading, no error
// and nothing in the console. That is the shape a stale service worker takes when it meets a
// route newer than its build, so the page has to say something, and must not be indexable —
// the SPA shell answers 200 for every unknown path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../src/components/Header', () => ({ Header: () => null }));
vi.mock('../../src/components/Footer', () => ({ Footer: () => null }));

import { NotFoundPage } from '../../src/pages/NotFoundPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <NotFoundPage />
    </MemoryRouter>
  );
}

describe('NotFoundPage', () => {
  beforeEach(() => { document.title = 'Unstream'; });
  afterEach(cleanup);

  it('says something, rather than rendering an empty page', () => {
    const { container } = renderPage();

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(container.innerHTML).not.toBe('');
  });

  it('keeps itself out of the index, since the shell answers 200', () => {
    const { unmount } = renderPage();

    const meta = document.head.querySelector('meta[name="robots"]');
    expect(meta?.getAttribute('content')).toBe('noindex');

    // Scoped to this page: it is one tag on a shared <head>, so leaving it behind would
    // deindex whatever the user navigated to next.
    unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('titles the tab, and gives the title back on the way out', () => {
    const { unmount } = renderPage();
    expect(document.title).toBe('Page not found | Unstream');

    unmount();
    expect(document.title).toBe('Unstream');
  });

  it('offers somewhere to go, and names the refresh that fixes a stale build', () => {
    renderPage();

    expect(screen.getByRole('link', { name: 'Search for an artist' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'Browse artists' }).getAttribute('href')).toBe('/artists');
    expect(screen.getByText(/try reloading the page first/i)).toBeTruthy();
  });
});
