// @vitest-environment jsdom
// Audit 2026-10-25 #10: a route change swapped the page silently — focus stayed on the clicked
// link, nothing was announced, and many routes never set a title. RouteOrientation gives each
// route a title and, on forward navigation, focuses the new page's heading (or announces the
// title when there is none). Back/forward, hash links and typing are left alone.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import { RouteOrientation } from 'src/components/RouteOrientation';
import { SkipLink } from 'src/components/SkipLink';
import { titleForPath } from 'src/data/routeTitles';

function Home() {
  return (
    <main>
      <Link to="/faq">To FAQ</Link>
      <Link to="/settings">To settings</Link>
      <Link to="/faq#install">To FAQ anchor</Link>
    </main>
  );
}

function Faq() {
  const navigate = useNavigate();
  return (
    <main>
      <h1>Frequently asked questions</h1>
      <button onClick={() => navigate(-1)}>Back</button>
    </main>
  );
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SkipLink />
      <RouteOrientation />
      {/* Stays mounted across routes, like the header's search box. */}
      <header><input aria-label="Search" /></header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/faq" element={<Faq />} />
        <Route path="/settings" element={<main><p>No heading here</p></main>} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe('RouteOrientation', () => {
  it('focuses the new page\'s heading on a forward navigation and sets its title', async () => {
    renderApp();
    fireEvent.click(screen.getByText('To FAQ'));

    const heading = screen.getByRole('heading', { name: 'Frequently asked questions' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.title).toBe('FAQ | Unstream');
  });

  it('announces the title when the new page has no heading to land on', async () => {
    renderApp();
    fireEvent.click(screen.getByText('To settings'));

    await waitFor(
      () => expect(screen.getByRole('status').textContent).toBe('Settings | Unstream'),
      { timeout: 4000 },
    );
  });

  it('leaves focus alone for a hash link', async () => {
    renderApp();
    const link = screen.getByText('To FAQ anchor');
    link.focus();
    fireEvent.click(link);

    await new Promise(r => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(screen.getByRole('heading'));
  });

  it('does not take focus from a text field', async () => {
    renderApp();
    const input = screen.getByLabelText('Search');
    input.focus();
    // A navigation while typing — the header search does exactly this.
    fireEvent.click(screen.getByText('To FAQ'));

    await new Promise(r => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(screen.getByRole('heading'));
  });
});

describe('route titles', () => {
  it('names routes that never set a title themselves', () => {
    expect(titleForPath('/privacy-policy')).toBe('Privacy policy | Unstream');
    expect(titleForPath('/u/fan')).toBe('Collection | Unstream');
    expect(titleForPath('/releases/kid-lightbulbs')).toBe('Manage releases | Unstream');
    expect(titleForPath('/artist-edit/kid-lightbulbs')).toBe('Edit profile | Unstream');
  });

  it('leaves the search page and unknown paths to themselves', () => {
    expect(titleForPath('/')).toBeNull();
    expect(titleForPath('/no-such-page')).toBeNull();
  });
});

describe('SkipLink', () => {
  it('moves focus to the main landmark', () => {
    renderApp();
    fireEvent.click(screen.getByText('Skip to main content'));
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
