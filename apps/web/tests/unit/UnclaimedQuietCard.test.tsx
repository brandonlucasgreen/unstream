// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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
    expect(screen.getByText('Marketplaces')).toBeTruthy();
    expect(screen.getByText('Bandcamp')).toBeTruthy();
  });

  it('renders platform links as pills in a responsive row', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    const pill = document.querySelector('a.source-badge[href="https://some-artist.bandcamp.com"]');
    expect(pill).toBeTruthy();
    expect(pill!.closest('.platform-pill-row')).toBeTruthy();
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

  it('does not render the claim nudge (link is dead until /claim routing is fixed)', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.queryByText('Claim this profile →')).toBeNull();
    expect(screen.queryByText(/Are you Some Artist\?/)).toBeNull();
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

  it('does not render Powered by Unstream footer', () => {
    render(<UnclaimedQuietCard payload={unclaimedPayload} slug="some-artist" />);
    expect(screen.queryByText('Powered by Unstream')).toBeNull();
  });
});

type Link = ArtistPagePayload['links'][number];

const link = (platform: string, url: string, displayName: string, payoutPercent: string | null = null): Link =>
  ({ platform, url, displayName, payoutPercent, bandcampFriday: false });

const bandcamp = link('bandcamp', 'https://annavonhausswolff.bandcamp.com', 'Bandcamp', '80-85%');
const patreon = link('patreon', 'https://patreon.com/avh', 'Patreon', '86-90%');
const officialSite = link('officialsite', 'https://annavonhausswolff.com', 'Official Site');
const instagram = link('instagram', 'https://instagram.com/avh', 'Instagram');
const youtube = link('youtube', 'https://youtube.com/@avh', 'YouTube');

const sectionedPayload: ArtistPagePayload = {
  artist: {
    id: 'artist-1',
    slug: 'anna-von-hausswolff',
    name: 'Anna von Hausswolff',
    imageUrl: null,
    matchConfidence: 'verified',
    country: null,
    countryCode: null,
    city: null,
  },
  profile: null,
  linkGroups: [
    { section: 'patronage', links: [patreon], dividerIndexes: [] },
    { section: 'marketplaces', links: [bandcamp], dividerIndexes: [] },
    { section: 'social', links: [instagram, youtube], dividerIndexes: [] },
    { section: 'official', links: [officialSite], dividerIndexes: [] },
  ],
  sectionOrder: ['bio', 'featured', 'patronage', 'marketplaces', 'social'],
  // The shape the API served from UNS-221 until the fix: socials in `links` *and* in
  // `socialLinks`. A response like this can sit in the CDN for a day after the deploy, so
  // the card must not double them up from it.
  links: [patreon, bandcamp, instagram, youtube, officialSite],
  socialLinks: [
    { platform: 'instagram', url: instagram.url, displayName: 'Instagram' },
    { platform: 'youtube', url: youtube.url, displayName: 'YouTube' },
  ],
  bandcampFriday: false,
};

function headings() {
  return screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
}

// The pre-generated pages and every other artist nobody has claimed group their links the way a
// claimed page does — Patronage, Marketplaces, Official, Follow — and show each link once.
describe('UnclaimedQuietCard link sections', () => {
  afterEach(cleanup);

  it('uses the claimed page section headings, in the default order', () => {
    render(<UnclaimedQuietCard payload={sectionedPayload} slug="anna-von-hausswolff" />);
    expect(headings()).toEqual(['Patronage', 'Marketplaces', 'Official', 'Follow']);
    expect(screen.queryByText(/support directly/i)).toBeNull();
  });

  it('shows each social link once, under Follow only', () => {
    render(<UnclaimedQuietCard payload={sectionedPayload} slug="anna-von-hausswolff" />);
    for (const social of [instagram, youtube]) {
      const anchors = screen.getAllByRole('link').filter(a => a.getAttribute('href') === social.url);
      expect(anchors).toHaveLength(1);
    }
    const follow = screen.getByRole('heading', { name: 'Follow' }).parentElement!;
    expect(within(follow).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual([
      instagram.url,
      youtube.url,
    ]);
  });

  it('groups the legacy flat fields the same way when a cached response has no sections', () => {
    const legacy: ArtistPagePayload = {
      ...sectionedPayload,
      linkGroups: undefined,
      sectionOrder: undefined,
      links: [patreon, bandcamp, officialSite],
    };
    render(<UnclaimedQuietCard payload={legacy} slug="anna-von-hausswolff" />);
    expect(headings()).toEqual(['Patronage', 'Marketplaces', 'Official', 'Follow']);
    expect(screen.getAllByRole('link').filter(a => a.getAttribute('href') === instagram.url)).toHaveLength(1);
  });

  it('skips sections with nothing in them', () => {
    const onlyBandcamp: ArtistPagePayload = {
      ...sectionedPayload,
      linkGroups: [{ section: 'marketplaces', links: [bandcamp], dividerIndexes: [] }],
      links: [bandcamp],
      socialLinks: [],
    };
    render(<UnclaimedQuietCard payload={onlyBandcamp} slug="anna-von-hausswolff" />);
    expect(headings()).toEqual(['Marketplaces']);
  });
});
