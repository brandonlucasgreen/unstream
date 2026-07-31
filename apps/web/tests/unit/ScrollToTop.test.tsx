// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import { ScrollToTop } from 'src/components/ScrollToTop';

function GuidesPage() {
  return (
    <>
      <Link to="/artist/beyonce">To artist</Link>
      <Link to="/guides?page=2">Same page, new query</Link>
      <Link to="/artist/beyonce#releases">To artist anchor</Link>
    </>
  );
}

function ArtistPage() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Go back</button>;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/guides']}>
      <ScrollToTop />
      <Routes>
        <Route path="/guides" element={<GuidesPage />} />
        <Route path="/artist/:slug" element={<ArtistPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ScrollToTop', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  });

  afterEach(cleanup);

  it('does not scroll on the initial render', () => {
    renderApp();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls to the top when the pathname changes', () => {
    renderApp();
    fireEvent.click(screen.getByText('To artist'));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('leaves the scroll position alone when only the query string changes', () => {
    renderApp();
    fireEvent.click(screen.getByText('Same page, new query'));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves the scroll position alone when the URL has a hash', () => {
    renderApp();
    fireEvent.click(screen.getByText('To artist anchor'));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves back navigation to the browser', () => {
    renderApp();
    fireEvent.click(screen.getByText('To artist'));
    scrollTo.mockClear();
    fireEvent.click(screen.getByText('Go back'));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
