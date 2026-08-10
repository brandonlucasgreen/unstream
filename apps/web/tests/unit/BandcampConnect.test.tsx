// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { BandcampConnect } from '../../src/components/BandcampConnect';

function statusResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

describe('BandcampConnect', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ session: { access_token: 'test-token' } });
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the connect form with the Bandcamp settings link when not connected', async () => {
    mockFetch.mockResolvedValueOnce(statusResponse({ connected: false }));

    render(<BandcampConnect />);

    await waitFor(() => {
      expect(screen.getByLabelText('Bandcamp username')).not.toBeNull();
    });
    expect(screen.getByLabelText('Subsonic credential')).not.toBeNull();
    const link = screen.getByRole('link', { name: /Fan Settings/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://bandcamp.com/settings');
    // The beta caveat is part of the honesty contract in the spec.
    expect(screen.getByText(/beta/)).not.toBeNull();
  });

  it('submits the credential once and clears the form fields on success', async () => {
    mockFetch.mockResolvedValueOnce(statusResponse({ connected: false }));
    mockFetch.mockResolvedValueOnce(
      statusResponse({ connected: true, username: 'fan', syncStatus: 'syncing', syncError: null })
    );

    render(<BandcampConnect />);
    await waitFor(() => {
      expect(screen.getByLabelText('Bandcamp username')).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Bandcamp username'), { target: { value: 'fan' } });
    fireEvent.change(screen.getByLabelText('Subsonic credential'), { target: { value: 'sekrit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Bandcamp' }));

    await waitFor(() => {
      expect(screen.getByText(/Importing your collection/)).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/bandcamp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'fan', password: 'sekrit' }),
      })
    );
  });

  it('surfaces the server error message on a rejected credential', async () => {
    mockFetch.mockResolvedValueOnce(statusResponse({ connected: false }));
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Bandcamp rejected that username or credential.' }),
    });

    render(<BandcampConnect />);
    await waitFor(() => {
      expect(screen.getByLabelText('Bandcamp username')).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Bandcamp username'), { target: { value: 'fan' } });
    fireEvent.change(screen.getByLabelText('Subsonic credential'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Bandcamp' }));

    await waitFor(() => {
      expect(screen.getByText(/rejected that username or credential/)).not.toBeNull();
    });
    // Still on the form so the user can retry.
    expect(screen.getByLabelText('Bandcamp username')).not.toBeNull();
  });

  it('shows sync results and offers re-sync when connected and idle', async () => {
    mockFetch.mockResolvedValueOnce(
      statusResponse({
        connected: true,
        username: 'fan',
        syncStatus: 'idle',
        syncError: null,
        itemCount: 128,
        lastSyncedAt: '2026-08-09T12:00:00Z',
      })
    );

    render(<BandcampConnect />);

    await waitFor(() => {
      expect(screen.getByText('fan')).not.toBeNull();
    });
    expect(screen.getByText(/128 releases imported/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Re-sync' })).not.toBeNull();
  });

  it('disconnecting asks what to do with imported items', async () => {
    mockFetch.mockResolvedValueOnce(
      statusResponse({ connected: true, username: 'fan', syncStatus: 'idle', itemCount: 5 })
    );
    mockFetch.mockResolvedValueOnce(statusResponse({ connected: false, itemsDeleted: 5 }));

    render(<BandcampConnect />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('button', { name: 'Disconnect, keep items' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect and delete items' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Bandcamp username')).not.toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/bandcamp',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ deleteItems: true }),
      })
    );
  });

  it('shows the sync error with a re-sync path when the import failed', async () => {
    mockFetch.mockResolvedValueOnce(
      statusResponse({
        connected: true,
        username: 'fan',
        syncStatus: 'error',
        syncError: 'The sync failed partway through.',
      })
    );

    render(<BandcampConnect />);

    await waitFor(() => {
      expect(screen.getByText('The sync failed partway through.')).not.toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Re-sync' })).not.toBeNull();
  });
});
