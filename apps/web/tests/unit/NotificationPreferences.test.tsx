// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { NotificationPreferences } from '../../src/components/NotificationPreferences';

describe('NotificationPreferences', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ session: { access_token: 'test-token' } });
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all three toggles reflecting the fetched state', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ newRelease: true, newPlatformLink: false, weeklyAnalyticsRecap: true }),
    });

    render(<NotificationPreferences />);

    await waitFor(() => {
      expect(screen.getByText('New releases')).not.toBeNull();
    });
    expect(screen.getByText('New places to support')).not.toBeNull();
    expect(screen.getByText('Weekly analytics recap')).not.toBeNull();

    expect(screen.getByRole('switch', { name: 'New releases' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'New places to support' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Weekly analytics recap' }).getAttribute('aria-checked')).toBe('true');
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
});
