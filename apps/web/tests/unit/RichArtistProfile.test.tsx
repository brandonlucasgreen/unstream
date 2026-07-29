// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RichArtistProfile } from 'src/components/RichArtistProfile';
import type { ArtistPagePayload } from 'src/types/artist-page';

const basePayload: ArtistPagePayload = {
  artist: {
    id: 'artist-1',
    slug: 'kid-lightbulbs',
    name: 'Kid Lightbulbs',
    imageUrl: 'https://example.com/image.jpg',
    matchConfidence: 'claimed',
    country: 'United States',
    countryCode: 'US',
    city: 'Northampton',
  },
  profile: {
    bio: 'An indie band from Massachusetts.',
    customImageUrl: null,
    featuredEmbed: '<iframe src="https://bandcamp.com/embed" width="100%" height="120"></iframe>',
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
    {
      platform: 'patreon',
      url: 'https://patreon.com/kidlightbulbs',
      displayName: 'Patreon',
      payoutPercent: '86-90%',
      bandcampFriday: false,
    },
  ],
  socialLinks: [
    {
      platform: 'instagram',
      url: 'https://instagram.com/kidlightbulbs',
      displayName: 'Instagram',
    },
  ],
  bandcampFriday: false,
};

describe('RichArtistProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the artist name and image', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Kid Lightbulbs' })).toBeTruthy();
    const img = screen.getByRole('img', { name: 'Kid Lightbulbs' });
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('https://example.com/image.jpg');
  });

  it('renders the verified badge when matchConfidence is claimed', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('does not render the verified badge when matchConfidence is not claimed', () => {
    const payload = { ...basePayload, artist: { ...basePayload.artist, matchConfidence: 'unverified' as const } };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.queryByText('Verified')).toBeNull();
  });

  it('renders the location as "City, Country" when both are present', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Northampton, United States')).toBeTruthy();
  });

  it('renders the location as city only when country is null', () => {
    const payload = { ...basePayload, artist: { ...basePayload.artist, country: null, countryCode: null } };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Northampton')).toBeTruthy();
  });

  it('renders the location as country only when city is null', () => {
    const payload = { ...basePayload, artist: { ...basePayload.artist, city: null } };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.getByText('United States')).toBeTruthy();
  });

  it('renders the bio when profile.bio is set', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('An indie band from Massachusetts.')).toBeTruthy();
  });

  it('skips the bio when profile.bio is null', () => {
    const payload = { ...basePayload, profile: { ...basePayload.profile!, bio: null } };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.queryByText('An indie band from Massachusetts.')).toBeNull();
  });

  it('renders the featured embed via dangerouslySetInnerHTML', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Featured Release')).toBeTruthy();
    const iframe = document.querySelector('iframe[src="https://bandcamp.com/embed"]');
    expect(iframe).toBeTruthy();
  });

  it('skips the featured embed when null', () => {
    const payload = { ...basePayload, profile: { ...basePayload.profile!, featuredEmbed: null } };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.queryByText('Featured Release')).toBeNull();
  });

  it('renders each main link with data-track-platform, target, and rel', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    const bandcampLink = document.querySelector('a[data-track-platform="bandcamp"]');
    expect(bandcampLink).toBeTruthy();
    expect(bandcampLink!.getAttribute('target')).toBe('_blank');
    expect(bandcampLink!.getAttribute('rel')).toBe('noopener noreferrer');

    const patreonLink = document.querySelector('a[data-track-platform="patreon"]');
    expect(patreonLink).toBeTruthy();
  });

  it('renders the payout percent when link.payoutPercent is set', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('80-85% to artist')).toBeTruthy();
    expect(screen.getByText('86-90% to artist')).toBeTruthy();
  });

  it('renders the Bandcamp Friday badge when link.bandcampFriday is true', () => {
    const payload = {
      ...basePayload,
      links: basePayload.links.map(l =>
        l.platform === 'bandcamp' ? { ...l, bandcampFriday: true, payoutPercent: '~97%' } : l
      ),
    };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Bandcamp Friday!')).toBeTruthy();
  });

  it('renders no dividers when linkDividers is absent', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(document.querySelectorAll('hr').length).toBe(0);
  });

  it('renders a divider above the link index it points at', () => {
    render(<RichArtistProfile payload={{ ...basePayload, linkDividers: [1] }} slug="kid-lightbulbs" />);
    const divider = document.querySelector('hr');
    expect(divider).toBeTruthy();
    expect(divider!.nextElementSibling?.getAttribute('data-track-platform')).toBe('patreon');
  });

  it('renders the social links section only when socialLinks.length > 0', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Follow')).toBeTruthy();
    expect(screen.getByText('Instagram')).toBeTruthy();
  });

  it('hides the social links section when empty', () => {
    const payload = { ...basePayload, socialLinks: [] };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    expect(screen.queryByText('Follow')).toBeNull();
  });

  it('renders the embed widget with the artist name in the code snippet', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    fireEvent.click(screen.getByText('Embed this profile on your website'));
    const codeBlock = document.querySelector('pre');
    expect(codeBlock).toBeTruthy();
    expect(codeBlock!.textContent).toContain('data-artist="Kid Lightbulbs"');
    expect(codeBlock!.textContent).toContain('/widget.js');
    expect(codeBlock!.textContent).toContain('class="unstream-widget"');
  });

  it('updates the embed code when theme or link count changes', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    fireEvent.click(screen.getByText('Embed this profile on your website'));

    // Change theme to light
    const lightButtons = screen.getAllByRole('button', { name: 'Light' });
    fireEvent.click(lightButtons[0]);
    const codeBlock = document.querySelector('pre');
    expect(codeBlock!.textContent).toContain('data-theme="light"');

    // Change link count via slider
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: 10 } });
    expect(codeBlock!.textContent).toContain('data-max-links="10"');
  });

  it('copies the code to clipboard and shows Copied! feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    fireEvent.click(screen.getByText('Embed this profile on your website'));

    const copyBtn = screen.getByText('Copy');
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeTruthy();
    });
  });

  it('renders the post-claim banner when justClaimed is true', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" justClaimed />);
    expect(screen.getByText(/You're verified! Welcome to Unstream\./)).toBeTruthy();
  });

  it('does not render the post-claim banner when justClaimed is false or absent', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.queryByText(/You're verified!/)).toBeNull();
  });

  it('dismisses the post-claim banner when the ✕ button is clicked', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" justClaimed />);
    expect(screen.getByText(/You're verified!/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText(/You're verified!/)).toBeNull();
  });

  it('renders the save button when onSave is provided', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" onSave={vi.fn()} />);
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('renders Saved state when isSaved is true', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" onSave={vi.fn()} onUnsave={vi.fn()} isSaved />);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('calls onSave when save button is clicked', () => {
    const onSave = vi.fn();
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" onSave={onSave} />);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalled();
  });

  it('calls onUnsave when saved button is clicked', () => {
    const onUnsave = vi.fn();
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" onSave={vi.fn()} onUnsave={onUnsave} isSaved />);
    fireEvent.click(screen.getByText('Saved'));
    expect(onUnsave).toHaveBeenCalled();
  });

  it('disables save button when disabledSave is true', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" onSave={vi.fn()} disabledSave />);
    const btn = screen.getByText('Save').closest('button');
    expect(btn?.disabled).toBe(true);
  });
});