// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { UnclaimedQuietCard } from 'src/components/UnclaimedQuietCard';
import type { ArtistPagePayload } from 'src/types/artist-page';

// Mock react-router-dom Link
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

// Mock analytics
vi.mock('src/services/analytics', () => ({
  analytics: { trackArtistLinkClick: vi.fn(), trackDownload: vi.fn() },
}));

// Mock PlatformIcon
vi.mock('src/components/PlatformIcon', () => ({
  PlatformIcon: ({ sourceId }: any) => <span data-testid={`platform-icon-${sourceId}`}>{sourceId}</span>,
}));

// Mock SocialIcon
vi.mock('src/components/SocialIcon', () => ({
  SocialIcon: ({ platform }: any) => <span data-testid={`social-icon-${platform}`}>{platform}</span>,
}));

const unclaimedPayload: ArtistPagePayload = {
  artist: {
    id: 'artist-2',
    slug: 'some-artist',
    name: 'Some Artist',
    imageUrl: 'https://example.com/some.jpg',
    matchConfidence: 'verified',
    country: 'Canada',
    countryCode: 'CA',
    city: 'Toronto',
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
  socialLinks: [
    {
      platform: 'instagram',
      url: 'https://instagram.com/someartist',
      displayName: 'Instagram',
    },
  ],
  bandcampFriday: false,
};

describe('UnclaimedQuietCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the artist name', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText('Some Artist')).toBeTruthy();
  });

  it('renders location text', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText('Toronto, Canada')).toBeTruthy();
  });

  it('renders platform links', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText('Support directly')).toBeTruthy();
    expect(screen.getByText('Bandcamp')).toBeTruthy();
  });

  it('renders social links', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText('Follow')).toBeTruthy();
    expect(screen.getByText('Instagram')).toBeTruthy();
  });

  it('does not render bio (profile is null)', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    // There should be no bio section
    expect(screen.queryByText(/An indie band/)).toBeNull();
  });

  it('does not render verified badge', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.queryByText('Verified')).toBeNull();
  });

  it('does not render embed widget section', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.queryByText(/Embed this profile/)).toBeNull();
  });

  it('shows claim nudge linking to /claim?slug=', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    const claimLink = screen.getByText('Claim this profile →');
    expect(claimLink).toBeTruthy();
    expect(claimLink.closest('a')?.getAttribute('href')).toContain('/claim?slug=some-artist');
  });

  it('shows claim nudge with artist name', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText(/Are you Some Artist\?/)).toBeTruthy();
  });

  it('renders the post-claim banner when justClaimed is true', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" justClaimed />);
    expect(screen.getByText(/You're verified! Welcome to Unstream\./)).toBeTruthy();
  });

  it('does not render the post-claim banner when justClaimed is false', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" justClaimed={false} />);
    expect(screen.queryByText(/You're verified!/)).toBeNull();
  });

  it('dismisses the post-claim banner when ✕ is clicked', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" justClaimed />);
    const dismissBtn = screen.getByLabelText('Dismiss');
    fireEvent.click(dismissBtn);
    expect(screen.queryByText(/You're verified!/)).toBeNull();
  });

  it('renders save button when onSave is provided', () => {
    const onSave = vi.fn();
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" onSave={onSave} />);
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('renders saved state when isSaved is true', () => {
    const onSave = vi.fn();
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" onSave={onSave} isSaved />);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('calls onSave when save button is clicked', () => {
    const onSave = vi.fn();
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" onSave={onSave} />);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalled();
  });

  it('calls onUnsave when saved button is clicked', () => {
    const onUnsave = vi.fn();
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" onSave={vi.fn()} onUnsave={onUnsave} isSaved />);
    fireEvent.click(screen.getByText('Saved'));
    expect(onUnsave).toHaveBeenCalled();
  });

  it('renders Powered by Unstream footer', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.getByText('Powered by Unstream')).toBeTruthy();
  });
});