// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock AuthContext
const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { SharingControls } from '../../src/components/SharingControls';

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <SharingControls />
    </MemoryRouter>
  );
}

describe('SharingControls', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      session: { access_token: 'test-token' },
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders no-username state with link to /settings', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404 });

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('Set a username to share your saved artists.')).not.toBeNull();
    });
    expect(screen.getByText('Set username').getAttribute('href')).toBe('/settings');
  });

  it('renders private state with Make public button', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ public: false, public_handle: null, public_url: null }),
    });

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('Your saved artists are private.')).not.toBeNull();
    });
    expect(screen.getByText('Make public')).not.toBeNull();
  });

  it('renders public state with URL, Copy, and Make private', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public: true,
        public_handle: 'testuser',
        public_url: 'https://unstream.stream/u/testuser',
      }),
    });

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('Your saved artists are public.')).not.toBeNull();
    });
    expect(screen.getByText('https://unstream.stream/u/testuser')).not.toBeNull();
    expect(screen.getByText('Copy')).not.toBeNull();
    expect(screen.getByText('Make private')).not.toBeNull();
  });

  it('calls API to enable sharing when Make public is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ public: false, public_handle: null, public_url: null }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public: true,
        public_handle: 'testuser',
        public_url: 'https://unstream.stream/u/testuser',
      }),
    });

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('Make public')).not.toBeNull();
    });

    fireEvent.click(screen.getByText('Make public'));

    await waitFor(() => {
      expect(screen.getByText('Your saved artists are public.')).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/saved-artists-sharing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ public: true }),
      })
    );
  });

  it('calls API to disable sharing when Make private is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public: true,
        public_handle: 'testuser',
        public_url: 'https://unstream.stream/u/testuser',
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ public: false, public_handle: null, public_url: null }),
    });

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('Make private')).not.toBeNull();
    });

    fireEvent.click(screen.getByText('Make private'));

    await waitFor(() => {
      expect(screen.getByText('Your saved artists are private.')).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/saved-artists-sharing',
      expect.objectContaining({
        body: JSON.stringify({ public: false }),
      })
    );
  });
});