// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

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
      expect(screen.getByLabelText('Username (from Bandcamp)')).not.toBeNull();
    });
    expect(screen.getByLabelText('Password (from Bandcamp)')).not.toBeNull();
    const link = screen.getByRole('link', { name: /Fan Settings/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://bandcamp.com/settings?pane=fan');
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
      expect(screen.getByLabelText('Username (from Bandcamp)')).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Username (from Bandcamp)'), { target: { value: 'fan' } });
    fireEvent.change(screen.getByLabelText('Password (from Bandcamp)'), { target: { value: 'sekrit' } });
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
      expect(screen.getByLabelText('Username (from Bandcamp)')).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Username (from Bandcamp)'), { target: { value: 'fan' } });
    fireEvent.change(screen.getByLabelText('Password (from Bandcamp)'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Bandcamp' }));

    await waitFor(() => {
      expect(screen.getByText(/rejected that username or credential/)).not.toBeNull();
    });
    // Still on the form so the user can retry.
    expect(screen.getByLabelText('Username (from Bandcamp)')).not.toBeNull();
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
      expect(screen.getByLabelText('Username (from Bandcamp)')).not.toBeNull();
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

// The poll that runs while a sync is in flight. Its ceiling has always been the server's —
// me-bandcamp.ts reports a sync as failed after 20 minutes, which flips syncStatus and ends
// the loop — but a flat 5s reached that ceiling in ~240 requests, kept running in a tab
// nobody was looking at, and could not escape a 429 at all.
describe('BandcampConnect sync polling', () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  }

  async function renderSyncing() {
    mockFetch.mockResolvedValue(
      statusResponse({ connected: true, username: 'fan', syncStatus: 'syncing', syncError: null })
    );
    render(<BandcampConnect />);
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
  }

  beforeEach(() => {
    mockUseAuth.mockReturnValue({ session: { access_token: 'test-token' } });
    mockFetch.mockReset();
    setHidden(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
    cleanup();
  });

  it('stops polling after a 429 rather than re-spending the budget as it refills', async () => {
    await renderSyncing();

    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Ten more minutes buy nothing: the loop is over until the user acts.
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through an ordinary error, which may well be transient', async () => {
    await renderSyncing();

    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await act(async () => { vi.advanceTimersByTime(5_000); });

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('widens the gap between checks as the sync goes on', async () => {
    await renderSyncing();

    // First minute: one check every 5s, while someone is plausibly watching.
    for (let i = 0; i < 12; i++) {
      await act(async () => { vi.advanceTimersByTime(5_000); });
    }
    expect(mockFetch).toHaveBeenCalledTimes(13);

    // Past a minute the gap is 15s, so 14.9s buys nothing.
    await act(async () => { vi.advanceTimersByTime(14_900); });
    expect(mockFetch).toHaveBeenCalledTimes(13);
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mockFetch).toHaveBeenCalledTimes(14);
  });

  it('spends no requests on a hidden tab, and refreshes on the way back', async () => {
    await renderSyncing();

    setHidden(true);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Returning shouldn't mean waiting out the gap to see whether the sync finished.
    setHidden(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not fetch on a visibility change that missed nothing', async () => {
    await renderSyncing();

    // Flipping to another tab and straight back, between ticks, is not a reason to poll.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
