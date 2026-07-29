// @vitest-environment jsdom
// Admin per-link removal on a search result: the control is admin-only, and the
// dialog sends the scope the admin chose.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderComponent, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCard } from 'src/components/ResultCard';
import type { SearchResult } from 'src/types';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: { access_token: 'admin-token' },
    isArtistSaved: () => false,
    saveArtist: vi.fn(),
    removeSavedArtist: vi.fn(),
  }),
}));

vi.mock('src/services/analytics', () => ({
  analytics: {
    trackPlatformClick: vi.fn(),
    trackArtistSearchAppearance: vi.fn(),
    trackArtistLinkClick: vi.fn(),
    trackSearch: vi.fn(),
  },
}));

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const RESULT: SearchResult = {
  id: 'test-taylor',
  name: 'Taylor Swift',
  type: 'artist',
  matchConfidence: 'verified',
  platforms: [
    { sourceId: 'bandcamp', url: 'https://taylorswift.bandcamp.com' },
    { sourceId: 'discogs', url: 'https://www.discogs.com/artist/1024240' },
  ],
};

// ResultCard's subtree renders react-router <Link>s, so it needs a router context.
const render = (ui: React.ReactElement) => renderComponent(<MemoryRouter>{ui}</MemoryRouter>);

describe('ResultCard admin link removal', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  });

  afterEach(cleanup);

  it('shows no remove control for non-admins', () => {
    render(<ResultCard result={RESULT} />);
    expect(screen.queryByLabelText(/Remove the .* link/)).toBeNull();
  });

  it('shows a remove control per platform for admins', () => {
    render(<ResultCard result={RESULT} isAdmin onLinkRemoved={vi.fn()} />);
    expect(screen.getAllByLabelText(/Remove the .* link/).length).toBeGreaterThanOrEqual(2);
  });

  it('suppresses the link for this artist only by default', async () => {
    const onLinkRemoved = vi.fn();
    render(<ResultCard result={RESULT} isAdmin onLinkRemoved={onLinkRemoved} />);

    fireEvent.click(screen.getByLabelText('Remove the Bandcamp link'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/link-suppression');
    expect(JSON.parse(options.body)).toMatchObject({
      url: 'https://taylorswift.bandcamp.com',
      source_id: 'bandcamp',
      artist_name: 'Taylor Swift',
      scope: 'artist',
    });
    expect(onLinkRemoved).toHaveBeenCalledWith('test-taylor', 'https://taylorswift.bandcamp.com');
  });

  it('sends a global scope when the admin picks every artist', async () => {
    render(<ResultCard result={RESULT} isAdmin onLinkRemoved={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Remove the Bandcamp link'));
    fireEvent.click(screen.getByRole('radio', { name: /Every artist/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).scope).toBe('global');
  });

  it('keeps the dialog open and reports the error when the save fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Database not configured' }) });
    const onLinkRemoved = vi.fn();
    render(<ResultCard result={RESULT} isAdmin onLinkRemoved={onLinkRemoved} />);

    fireEvent.click(screen.getByLabelText('Remove the Bandcamp link'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));

    await waitFor(() => expect(screen.getByText('Database not configured')).toBeTruthy());
    expect(onLinkRemoved).not.toHaveBeenCalled();
  });
});
