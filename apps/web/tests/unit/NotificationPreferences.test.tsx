// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const captureException = vi.fn();
vi.mock('@sentry/react', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { NotificationPreferences } from '../../src/components/NotificationPreferences';
import { RATE_LIMIT_MESSAGE } from '../../src/utils/rateLimit';

describe('NotificationPreferences', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ session: { access_token: 'test-token' } });
    mockFetch.mockReset();
    captureException.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the saved-artist toggles reflecting the fetched state', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: true, newPlatformLink: false, weeklyAnalyticsRecap: true }),
    });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByText('New releases')).not.toBeNull();
    });
    expect(screen.getByText('New places to support')).not.toBeNull();

    expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'New places to support' }).getAttribute('aria-checked')).toBe('false');
  });

  it('offers no switch for the paused weekly recap, even though the preference still exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: true, newPlatformLink: true, weeklyAnalyticsRecap: true }),
    });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByText('New releases')).not.toBeNull();
    });
    expect(screen.queryByText('Weekly analytics recap')).toBeNull();
  });

  it('toggles a preference off and reflects the server response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: true, newPlatformLink: true, weeklyAnalyticsRecap: true }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: false, newPlatformLink: true, weeklyAnalyticsRecap: true }),
    });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('true');
    });

    fireEvent.click(screen.getByRole('switch', { name: 'New releases' }));

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('false');
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/notification-preferences',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ newRelease: false }),
      }),
    );
  });

  it('shows an error and leaves the toggle unchanged when the update fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: true, newPlatformLink: true, weeklyAnalyticsRecap: true }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Failed to update notification preferences' }),
    });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('true');
    });

    fireEvent.click(screen.getByRole('switch', { name: 'New releases' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to update notification preferences')).not.toBeNull();
    });
    expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('true');
  });

  // A 429 is the shared per-IP budget refilling, not a fault. Reporting it as an exception is
  // what turned one rate-limited /settings load into five Sentry errors (UNSTREAM-WEB-12), none
  // of which said what had happened.
  it('explains a rate limit without reporting it to Sentry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByText(RATE_LIMIT_MESSAGE)).not.toBeNull();
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(screen.queryByText('Failed to load notification preferences.')).toBeNull();
  });
});
