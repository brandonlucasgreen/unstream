// @vitest-environment jsdom
// The frame around the artist settings tabs.
//
// What's worth locking: switching tabs swaps only the content. The heading and tab bar are the same
// DOM nodes before and after, and the artist's name — reported by whichever tab loaded first —
// stays while the next tab loads instead of dropping back to a placeholder.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ArtistSettingsLayout, useReportArtistName } from 'src/pages/ArtistSettingsLayout';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'user-token' } }),
}));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true }))));

// The profile tab reports the name; the releases tab hasn't loaded its data yet, so it reports none.
function ProfileTab() {
  useReportArtistName('Kid Lightbulbs');
  return <p>profile content</p>;
}
function ReleasesTab() {
  useReportArtistName(undefined);
  return <p>releases content</p>;
}

afterEach(cleanup);

describe('ArtistSettingsLayout', () => {
  it('keeps the heading and tabs, and the name, while the content changes', async () => {
    render(
      <MemoryRouter initialEntries={['/artist-edit/kid-lightbulbs']}>
        <Routes>
          <Route path="/artist-edit/:slug" element={<ArtistSettingsLayout />}>
            <Route index element={<ProfileTab />} />
            <Route path="releases" element={<ReleasesTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const heading = await screen.findByRole('heading', { name: 'Kid Lightbulbs' });
    const tabBar = screen.getByRole('navigation', { name: 'Artist settings' });
    expect(screen.getByText('profile content')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Manage Releases' }));

    await waitFor(() => expect(screen.getByText('releases content')).toBeTruthy());
    expect(screen.queryByText('profile content')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Kid Lightbulbs' })).toBe(heading);
    expect(screen.getByRole('navigation', { name: 'Artist settings' })).toBe(tabBar);
    expect(screen.getByRole('link', { name: 'Manage Releases' }).getAttribute('aria-current')).toBe('page');
  });
});
