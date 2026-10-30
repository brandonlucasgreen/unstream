// @vitest-environment jsdom
// The tabs along the top of /promote/:slug: Autopost is the page itself, and the tool under the
// tabs can still put the artist's name in the heading.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The site header and footer have their own tests and their own data.
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));

import { ArtistSettingsLayout, useReportArtistName } from 'src/pages/ArtistSettingsLayout';
import { PromoteTabsLayout } from 'src/components/PromoteTabs';

function Tool() {
  useReportArtistName('Kid Lightbulbs');
  return <p>autopost settings</p>;
}

afterEach(cleanup);

describe('PromoteTabs', () => {
  it('shows Autopost as the open tab at /promote/:slug, linking to the page itself', async () => {
    render(
      <MemoryRouter initialEntries={['/promote/kid-lightbulbs']}>
        <Routes>
          <Route path="/promote/:slug" element={<ArtistSettingsLayout section="promote" />}>
            <Route element={<PromoteTabsLayout />}>
              <Route index element={<Tool />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    );
    const nav = screen.getByRole('navigation', { name: 'Promotion tools' });
    const tab = screen.getByRole('link', { name: 'Autopost' });
    expect(nav.contains(tab)).toBe(true);
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(tab.getAttribute('href')).toBe('/promote/kid-lightbulbs');
    expect(screen.getByText('autopost settings')).toBeTruthy();
    // Through the tabs' own layout, the tool's name still reaches the heading.
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Promote: Kid Lightbulbs');
  });
});
