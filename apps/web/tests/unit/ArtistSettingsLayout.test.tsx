// @vitest-environment jsdom
// The frame around each page an artist manages from /my-artists, and the redirects from the tab
// addresses those pages had until 2026-10-29.
//
// What's worth locking: the page reports the artist's name up to the heading, and the old
// /artist-edit/:slug/tips address still lands on Manage Tips with its query intact, because
// Stripe's onboarding links (?stripe=return|refresh) and tip emails already sent point there.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ArtistSettingsLayout, RedirectToSection, useReportArtistName } from 'src/pages/ArtistSettingsLayout';

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));

function ReleasesContent() {
  useReportArtistName('Kid Lightbulbs');
  return <p>releases content</p>;
}

function WhereAmI() {
  const { pathname, search } = useLocation();
  return <p>at {pathname}{search}</p>;
}

afterEach(cleanup);

describe('ArtistSettingsLayout', () => {
  it('frames the page with what it is and the name the page reports', async () => {
    render(
      <MemoryRouter initialEntries={['/releases/kid-lightbulbs']}>
        <Routes>
          <Route path="/releases/:slug" element={<ArtistSettingsLayout section="releases" />}>
            <Route index element={<ReleasesContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Kid Lightbulbs' })).toBeTruthy();
    expect(screen.getByText('Manage releases')).toBeTruthy();
    expect(screen.getByText('releases content')).toBeTruthy();
  });
});

describe('RedirectToSection', () => {
  it('sends an old tips tab address to Manage Tips, keeping Stripe’s query', async () => {
    render(
      <MemoryRouter initialEntries={['/artist-edit/kid-lightbulbs/tips?stripe=return']}>
        <Routes>
          <Route path="/artist-edit/:slug/tips" element={<RedirectToSection to="tips" />} />
          <Route path="/tips/:slug" element={<WhereAmI />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('at /tips/kid-lightbulbs?stripe=return')).toBeTruthy();
  });

  it('sends an old releases tab address to Manage Releases', async () => {
    render(
      <MemoryRouter initialEntries={['/artist-edit/kid-lightbulbs/releases']}>
        <Routes>
          <Route path="/artist-edit/:slug/releases" element={<RedirectToSection to="releases" />} />
          <Route path="/releases/:slug" element={<WhereAmI />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('at /releases/kid-lightbulbs')).toBeTruthy();
  });
});
