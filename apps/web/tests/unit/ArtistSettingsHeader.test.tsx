// @vitest-environment jsdom
// The artist settings tabs (/artist-edit/:slug, /tips, /releases).
//
// What's worth locking: tips ship dark, so the Manage Tips tab appears only when the server says it
// has a Stripe key — and a failed check hides it rather than breaking the page. It asks once per
// visit, since the header stays mounted across tab switches. The current tab is marked for screen
// readers, and every tab links to its own route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistSettingsHeader, type ArtistSettingsTab } from 'src/components/ArtistSettingsHeader';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'user-token' } }),
}));

const captureException = vi.fn();
vi.mock('@sentry/react', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function renderHeader(active: ArtistSettingsTab) {
  return render(
    <MemoryRouter>
      <ArtistSettingsHeader slug="kid-lightbulbs" artistName="Kid Lightbulbs" active={active} />
    </MemoryRouter>
  );
}

const tabNames = () => screen.getAllByRole('link').map(a => a.textContent).filter(t => t?.startsWith('Edit') || t?.startsWith('Manage'));

beforeEach(() => {
  mockFetch.mockReset();
  captureException.mockReset();
});
afterEach(cleanup);

describe('ArtistSettingsHeader', () => {
  it('shows Manage Tips once the server says tips are available', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ available: true })));
    renderHeader('profile');
    await waitFor(() => expect(tabNames()).toEqual(['Edit Profile', 'Manage Tips', 'Manage Releases']));
    expect(mockFetch).toHaveBeenCalledWith('/api/tips/settings?summary=1', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer user-token' }),
    }));
    expect(screen.getByRole('link', { name: 'Manage Tips' }).getAttribute('href')).toBe('/artist-edit/kid-lightbulbs/tips');
    expect(screen.getByRole('link', { name: 'Manage Releases' }).getAttribute('href')).toBe('/artist-edit/kid-lightbulbs/releases');
  });

  it('hides Manage Tips while tips are dark', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ available: false })));
    renderHeader('releases');
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(tabNames()).toEqual(['Edit Profile', 'Manage Releases']);
  });

  it('hides Manage Tips and reports it when the check fails', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    renderHeader('profile');
    await waitFor(() => expect(captureException).toHaveBeenCalled());
    expect(tabNames()).toEqual(['Edit Profile', 'Manage Releases']);
  });

  it('marks the current tab, and keeps Manage Tips while on it even if tips are dark', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ available: false })));
    renderHeader('tips');
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('link', { name: 'Manage Tips' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Edit Profile' }).getAttribute('aria-current')).toBeNull();
  });

  it('asks once, not again on every tab switch', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ available: true })));
    const { rerender } = renderHeader('profile');
    await waitFor(() => expect(tabNames()).toContain('Manage Tips'));
    for (const active of ['tips', 'releases', 'profile'] as const) {
      rerender(
        <MemoryRouter>
          <ArtistSettingsHeader slug="kid-lightbulbs" artistName="Kid Lightbulbs" active={active} />
        </MemoryRouter>
      );
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
