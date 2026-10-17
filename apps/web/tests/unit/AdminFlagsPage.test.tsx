// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdminFlagsPage } from 'src/pages/AdminFlagsPage';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, session: { access_token: 'admin-token' } }),
}));

vi.mock('src/components/Header', () => ({
  Header: () => null,
}));

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// The registry UNS-215 ships: the one `tips` flag split in two, the dead `emailChange` one gone.
const OFF = { tipsArtists: false, tipsFans: false };

/** GET returns `getFlags`; POST echoes `postFlags` (or fails, when `postFails`). */
function setupFetchMock({
  getFlags = { ...OFF },
  postFlags,
  postFails = false,
}: { getFlags?: Record<string, boolean>; postFlags?: Record<string, boolean>; postFails?: boolean } = {}) {
  mockFetch.mockReset();
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (postFails) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ error: 'Feature flag store is unavailable — the flag was not changed' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ flags: postFlags }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ flags: getFlags }) });
  });
}

const switchFor = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;
const postCall = () => mockFetch.mock.calls.find(call => call[1]?.method === 'POST');

describe('AdminFlagsPage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => cleanup());

  it('renders one toggle per flag the server reports, with its caption', async () => {
    setupFetchMock();
    render(<AdminFlagsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Tips — artist onboarding' })).not.toBeNull();
    });

    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(switchFor('Tips — artist onboarding').getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Tips — fans').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('artists can start Stripe Connect registration; only admin-approved accounts can take money')).not.toBeNull();
    expect(screen.getByText('tip buttons on search results, artist pages, SEO pages, and checkout')).not.toBeNull();

    expect(mockFetch.mock.calls[0][0]).toBe('/api/admin/flags');
  });

  it('shows a flag the server reports as on', async () => {
    setupFetchMock({ getFlags: { tipsArtists: true, tipsFans: false } });
    render(<AdminFlagsPage />);

    await waitFor(() => {
      expect(switchFor('Tips — artist onboarding').getAttribute('aria-checked')).toBe('true');
    });
    // The two flags are independent: the artist one being on says nothing about the fan one.
    expect(switchFor('Tips — fans').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles the fan flag on its own', async () => {
    setupFetchMock({ postFlags: { tipsArtists: false, tipsFans: true } });
    render(<AdminFlagsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Tips — fans' })).not.toBeNull();
    });

    fireEvent.click(switchFor('Tips — fans'));

    await waitFor(() => {
      expect(postCall()).toBeDefined();
    });
    expect(JSON.parse(postCall()[1].body)).toEqual({ flag: 'tipsFans', enabled: true });
    expect(switchFor('Tips — artist onboarding').getAttribute('aria-checked')).toBe('false');
  });

  it('moves the switch on click and POSTs the flag and its new value', async () => {
    setupFetchMock({ postFlags: { tipsArtists: true, tipsFans: false } });
    render(<AdminFlagsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Tips — artist onboarding' })).not.toBeNull();
    });

    fireEvent.click(switchFor('Tips — artist onboarding'));

    // Optimistic: the switch has already moved, before the server answers.
    expect(switchFor('Tips — artist onboarding').getAttribute('aria-checked')).toBe('true');

    await waitFor(() => {
      expect(postCall()).toBeDefined();
    });
    expect(postCall()[0]).toBe('/api/admin/flags');
    expect(JSON.parse(postCall()[1].body)).toEqual({ flag: 'tipsArtists', enabled: true });
    expect((postCall()[1].headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
  });

  it('reverts the switch and says so when the write fails', async () => {
    setupFetchMock({ postFails: true });
    render(<AdminFlagsPage />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Tips — artist onboarding' })).not.toBeNull();
    });

    fireEvent.click(switchFor('Tips — artist onboarding'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull();
    });
    // Reverted: an optimistic move must not survive a failed write.
    expect(switchFor('Tips — artist onboarding').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
  });
});
