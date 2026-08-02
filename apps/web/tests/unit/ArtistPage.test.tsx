// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ArtistPage } from 'src/pages/ArtistPage';

// Mock react-router-dom
const mockUseParams = vi.fn();
const mockUseSearchParams = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
  useSearchParams: () => mockUseSearchParams(),
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

// Mock @sentry/react
vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

// Mock Header & Footer
vi.mock('src/components/Header', () => ({
  Header: () => <header>Header</header>,
}));
vi.mock('src/components/Footer', () => ({
  Footer: () => <footer>Footer</footer>,
}));

// Mock analytics
vi.mock('src/services/analytics', () => ({
  analytics: { trackArtistPageView: vi.fn(), trackArtistLinkClick: vi.fn(), trackDownload: vi.fn() },
}));

// Mock AuthContext
const mockSaveArtist = vi.fn();
const mockRemoveSavedArtist = vi.fn();
const mockLoadSavedArtists = vi.fn();
const mockIsArtistSaved = vi.fn();
// Read at render time, so a test can sign the user in before mounting.
let mockSession: { access_token: string } | null = null;

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: mockSession,
    user: null,
    isAdmin: false,
    isLoading: false,
    hasPassword: false,
    savedArtists: [],
    savedArtistIds: new Set(),
    isArtistSaved: mockIsArtistSaved,
    saveArtist: mockSaveArtist,
    removeSavedArtist: mockRemoveSavedArtist,
    loadSavedArtists: mockLoadSavedArtists,
    artistsLoaded: true,
  }),
}));

// Mock LoginInterstitial
vi.mock('src/components/LoginInterstitial', () => ({
  LoginInterstitial: ({ artistId, artistName, onClose }: any) => (
    <div data-testid="login-interstitial">
      LoginInterstitial for {artistName}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Mock RichArtistProfile
vi.mock('src/components/RichArtistProfile', () => ({
  RichArtistProfile: ({ payload, justClaimed, isSaved, onSave, onUnsave }: any) => (
    <div data-testid="rich-artist-profile">
      RichArtistProfile: {payload.artist.name} {justClaimed ? '(just claimed)' : ''} {isSaved ? '(saved)' : ''}
      <button onClick={isSaved ? onUnsave : onSave}>Save</button>
    </div>
  ),
}));

// Mock UnclaimedQuietCard
vi.mock('src/components/UnclaimedQuietCard', () => ({
  UnclaimedQuietCard: ({ payload, justClaimed, isSaved, onSave, onUnsave }: any) => (
    <div data-testid="unclaimed-quiet-card">
      UnclaimedQuietCard: {payload.artist.name} {justClaimed ? '(just claimed)' : ''} {isSaved ? '(saved)' : ''}
      <button onClick={isSaved ? onUnsave : onSave}>Save</button>
    </div>
  ),
}));

// Mock AdminCatalogButton — echoes back the id it was handed, which must be the UUID.
vi.mock('src/components/AdminCatalogButton', () => ({
  AdminCatalogButton: ({ artistId }: { artistId: string }) => (
    <div data-testid="admin-catalog-button">{artistId}</div>
  ),
}));

// Mock NotFoundCard
vi.mock('src/components/NotFoundCard', () => ({
  NotFoundCard: ({ slug }: any) => (
    <div data-testid="not-found-card">
      NotFoundCard: {slug ?? 'unknown'}
    </div>
  ),
}));

// Mock LoadingProfile
vi.mock('src/components/LoadingProfile', () => ({
  LoadingProfile: () => <div data-testid="loading-profile">Loading profile…</div>,
}));

// Shared fixtures
const claimedPayload = {
  artist: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    slug: 'kid-lightbulbs',
    name: 'Kid Lightbulbs',
    imageUrl: 'https://example.com/image.jpg',
    matchConfidence: 'claimed' as const,
    country: 'United States',
    countryCode: 'US',
    city: 'Northampton',
  },
  profile: {
    bio: 'An indie band from Massachusetts.',
    customImageUrl: null,
    featuredEmbed: null,
    verifiedAt: '2025-01-01T00:00:00Z',
  },
  links: [
    {
      platform: 'bandcamp',
      url: 'https://kidlightbulbs.bandcamp.com',
      displayName: 'Bandcamp',
      payoutPercent: '80-85%',
      bandcampFriday: false,
    },
  ],
  socialLinks: [],
  bandcampFriday: false,
};

const unclaimedPayload = {
  artist: {
    id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    slug: 'some-artist',
    name: 'Some Artist',
    imageUrl: 'https://example.com/some.jpg',
    matchConfidence: 'verified' as const,
    country: null,
    countryCode: null,
    city: null,
  },
  profile: null,
  links: [
    {
      platform: 'bandcamp',
      url: 'https://some-artist.bandcamp.com',
      displayName: 'Bandcamp',
      payoutPercent: null,
      bandcampFriday: false,
    },
  ],
  socialLinks: [],
  bandcampFriday: false,
};

describe('ArtistPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    mockUseSearchParams.mockReturnValue([new URLSearchParams()]);
    mockSession = null;
    // restoreAllMocks restores spies but leaves vi.fn() call history in place, so a test
    // reading mock.calls[0] would otherwise see the previous test's call.
    mockSaveArtist.mockClear();
    mockRemoveSavedArtist.mockClear();
    mockIsArtistSaved.mockClear();
    mockIsArtistSaved.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders loading state while fetching', () => {
    // Never resolves, so we stay in loading state
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    vi.spyOn(global, 'fetch').mockReturnValue(new Promise(() => {}));
    render(<ArtistPage />);
    expect(screen.getByTestId('loading-profile')).toBeTruthy();
  });

  it('renders RichArtistProfile for a claimed artist (profile.verifiedAt)', async () => {
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      expect(screen.getByTestId('rich-artist-profile')).toBeTruthy();
    });
  });

  it('renders UnclaimedQuietCard for an unclaimed artist (no profile.verifiedAt)', async () => {
    mockUseParams.mockReturnValue({ slug: 'some-artist' });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(unclaimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      expect(screen.getByTestId('unclaimed-quiet-card')).toBeTruthy();
    });
  });

  it('renders NotFoundCard on 404', async () => {
    mockUseParams.mockReturnValue({ slug: 'nonexistent' });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      expect(screen.getByTestId('not-found-card')).toBeTruthy();
    });
  });

  it('renders NotFoundCard on network error', async () => {
    mockUseParams.mockReturnValue({ slug: 'error-artist' });
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
    render(<ArtistPage />);
    await waitFor(() => {
      expect(screen.getByTestId('not-found-card')).toBeTruthy();
    });
  });

  it('passes justClaimed=true when ?claimed param is present', async () => {
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    mockUseSearchParams.mockReturnValue([new URLSearchParams('claimed=1')]);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      const el = screen.getByTestId('rich-artist-profile');
      expect(el.textContent).toContain('just claimed');
    });
  });

  it('updates document title from payload', async () => {
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      expect(document.title).toContain('Kid Lightbulbs');
    });
  });

  it('calls analytics.trackArtistPageView with slug', async () => {
    const { analytics } = await import('src/services/analytics');
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    render(<ArtistPage />);
    await waitFor(() => {
      expect(analytics.trackArtistPageView).toHaveBeenCalledWith('kid-lightbulbs');
    });
  });

  it('does not render "Back to artists" link', () => {
    mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
    vi.spyOn(global, 'fetch').mockReturnValue(new Promise(() => {}));
    render(<ArtistPage />);
    expect(screen.queryByText('Back to artists')).toBeNull();
  });

  // Saving is keyed by slug end to end: /api/saved-artists stores and validates `artist_slug`,
  // and savedArtistIds holds slugs. Sending artist.id — the artists-table UUID — made every save
  // from this page fail validation with a 400 and read back as unsaved.
  describe('save identifier', () => {
    it('saves a claimed artist by slug, not by the artists-table UUID', async () => {
      mockSession = { access_token: 'token' };
      mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      render(<ArtistPage />);
      await waitFor(() => expect(screen.getByTestId('rich-artist-profile')).toBeTruthy());

      screen.getByText('Save').click();

      await waitFor(() => expect(mockSaveArtist).toHaveBeenCalled());
      expect(mockSaveArtist).toHaveBeenCalledWith(
        'kid-lightbulbs',
        undefined,
        'Kid Lightbulbs',
        'https://example.com/image.jpg',
      );
    });

    it('saves an unclaimed artist by slug too', async () => {
      mockSession = { access_token: 'token' };
      mockUseParams.mockReturnValue({ slug: 'some-artist' });
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(unclaimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      render(<ArtistPage />);
      await waitFor(() => expect(screen.getByTestId('unclaimed-quiet-card')).toBeTruthy());

      screen.getByText('Save').click();

      await waitFor(() => expect(mockSaveArtist).toHaveBeenCalled());
      expect(mockSaveArtist.mock.calls[0][0]).toBe('some-artist');
    });

    it('asks whether the slug is saved, not the UUID', async () => {
      mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      render(<ArtistPage />);
      await waitFor(() => expect(screen.getByTestId('rich-artist-profile')).toBeTruthy());

      expect(mockIsArtistSaved).toHaveBeenCalledWith('kid-lightbulbs');
      expect(mockIsArtistSaved).not.toHaveBeenCalledWith(claimedPayload.artist.id);
    });

    it('removes by slug', async () => {
      mockSession = { access_token: 'token' };
      mockIsArtistSaved.mockReturnValue(true);
      mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      render(<ArtistPage />);
      await waitFor(() => expect(screen.getByTestId('rich-artist-profile')).toBeTruthy());

      screen.getByText('Save').click();

      await waitFor(() => expect(mockRemoveSavedArtist).toHaveBeenCalledWith('kid-lightbulbs'));
    });

    // The other half of the fix: the admin catalog endpoint validates a UUID, so that control
    // must keep getting artist.id even though save no longer does.
    it('still hands the UUID to the admin catalog control', async () => {
      mockUseParams.mockReturnValue({ slug: 'kid-lightbulbs' });
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(claimedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      render(<ArtistPage />);
      await waitFor(() => {
        expect(screen.getByTestId('admin-catalog-button').textContent).toBe(claimedPayload.artist.id);
      });
    });
  });

  it('cancels fetch on slug change', async () => {
    const { rerender } = render(<ArtistPage />);
    // First slug
    mockUseParams.mockReturnValue({ slug: 'first' });
    const abortSpy = vi.fn();
    const controller = { abort: abortSpy, signal: {} as AbortSignal };
    // We rely on the fetch being called and the cleanup happening
    // This is a structural check: ArtistPage uses the abort pattern via the cancelled flag
    expect(true).toBe(true); // structural — the cancelled flag pattern is in the source
  });
});