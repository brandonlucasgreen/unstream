// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { CollectionSection } from '../../src/components/CollectionSection';

const ITEM = {
  id: 'i-1',
  source: 'bandcamp',
  title: 'Illinois',
  artist_name: 'Sufjan Stevens',
  art_url: 'https://f4.bcbits.com/a.jpg',
  acquired_at: '2026-01-01T00:00:00Z',
  provenance: 'purchased',
  hidden: false,
  release_id: 'rel-1',
};

function renderSection() {
  return render(
    <MemoryRouter>
      <CollectionSection />
    </MemoryRouter>
  );
}

describe('CollectionSection', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ session: { access_token: 'test-token' } });
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('empty state points at the Bandcamp connect panel on the same page, not at search', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], total: 0 }) });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/No releases in your collection yet/)).not.toBeNull();
    });
    const link = screen.getByRole('link', { name: /Connect your collection below/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#bandcamp-connect');
  });

  it('renders items as an art grid with a hide control', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [ITEM], total: 1 }) });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('Illinois')).not.toBeNull();
    });
    expect(screen.getByAltText('Illinois by Sufjan Stevens')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Hide Illinois from your public page' })
    ).not.toBeNull();
  });

  it('toggles hidden via POST and reflects the server response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [ITEM], total: 1 }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...ITEM, hidden: true }) });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('Illinois')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Illinois from your public page' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show Illinois on your public page' })).not.toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/collection',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'i-1', hidden: true }),
      })
    );
  });
});
