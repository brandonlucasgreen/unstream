// @vitest-environment jsdom
// The admin backstop for tier-3 dedup: renders a queue of suspected-duplicate pairs and lets an
// admin dismiss ("not a duplicate") or merge ("same release, keep this one").
//
// What's worth locking: both merge buttons send the right (keepId, dropId) pairing — a swap
// here would merge the wrong release away — and a pair whose counterpart is gone still renders
// instead of disappearing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdminReleaseReviewPage } from 'src/pages/AdminReleaseReviewPage';

const mockSession = { access_token: 'admin-token' };
vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, session: mockSession }),
}));

vi.mock('src/components/Header', () => ({
  Header: () => null,
}));

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function releaseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Carrie & Lowell',
    slug: 'carrie-lowell',
    releaseType: 'album',
    releaseDate: '2015-03-31',
    datePrecision: 'day',
    artworkUrl: null,
    artistName: 'Sufjan Stevens',
    artistSlug: 'sufjan-stevens',
    platforms: ['bandcamp'],
    ...overrides,
  };
}

function setupFetchMock(pairs: unknown[]) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ pairs }),
  });
}

describe('AdminReleaseReviewPage', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows nothing-to-review as an explicit message, not a blank page', async () => {
    setupFetchMock([]);
    render(<AdminReleaseReviewPage />);
    await waitFor(() => {
      expect(screen.getByText('Nothing flagged for review right now.')).toBeTruthy();
    });
  });

  it('renders both sides of a pair', async () => {
    const primary = releaseItem();
    const counterpart = releaseItem({
      id: '22222222-2222-2222-2222-222222222222',
      title: 'Carrie & Lowell (Deluxe Edition)',
      slug: 'carrie-lowell-deluxe',
      platforms: ['discogs'],
    });
    setupFetchMock([{ primary, counterpart }]);

    render(<AdminReleaseReviewPage />);

    await waitFor(() => {
      expect(screen.getByText('Carrie & Lowell')).toBeTruthy();
      expect(screen.getByText('Carrie & Lowell (Deluxe Edition)')).toBeTruthy();
    });
  });

  // The one bug that would matter here: swapping keep/drop merges the wrong release away.
  it('sends the clicked card as keepId and the other as dropId', async () => {
    const primary = releaseItem();
    const counterpart = releaseItem({
      id: '22222222-2222-2222-2222-222222222222',
      title: 'Carrie & Lowell (Deluxe Edition)',
      slug: 'carrie-lowell-deluxe',
    });
    setupFetchMock([{ primary, counterpart }]);

    render(<AdminReleaseReviewPage />);
    await waitFor(() => screen.getByText('Carrie & Lowell (Deluxe Edition)'));

    const keepButtons = screen.getAllByText('Same release — keep this one');
    expect(keepButtons).toHaveLength(2);

    fireEvent.click(keepButtons[1]); // the counterpart's card

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({ action: 'merge', keepId: counterpart.id, dropId: primary.id });
    });
  });

  it('dismisses by releaseId of the primary side', async () => {
    setupFetchMock([{ primary: releaseItem(), counterpart: null }]);

    render(<AdminReleaseReviewPage />);
    await waitFor(() => screen.getByText('Carrie & Lowell'));

    fireEvent.click(screen.getByText('Not a duplicate'));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(call => call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall[1].body)).toEqual({
        action: 'dismiss',
        releaseId: releaseItem().id,
      });
    });
  });

  // A missing counterpart (already resolved from the other side, or deleted) must still show
  // the flagged release rather than vanish — it was flagged for a reason.
  it('renders a release alone when it has no counterpart, with no merge button', async () => {
    setupFetchMock([{ primary: releaseItem(), counterpart: null }]);

    render(<AdminReleaseReviewPage />);

    await waitFor(() => {
      expect(screen.getByText('Carrie & Lowell')).toBeTruthy();
      expect(screen.getByText(/no longer on file/)).toBeTruthy();
    });
    expect(screen.queryByText('Same release — keep this one')).toBeNull();
  });
});
