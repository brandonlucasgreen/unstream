// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RichArtistProfile } from 'src/components/RichArtistProfile';
import { isBandcampFriday } from 'src/utils/bandcamp-friday';
import type { ArtistPagePayload } from 'src/types/artist-page';

// SourceBadge reads the real clock to decide whether Bandcamp's payout shows as its usual
// percentage or the Bandcamp Friday override, so the payout tests below freeze the clock
// rather than asserting whatever today happens to be. Both dates are Pacific noon, the
// timezone isBandcampFriday() compares in. Keep them in step with BANDCAMP_FRIDAY_DATES in
// src/utils/bandcamp-friday.ts when that list is updated for a new year.
const ORDINARY_FRIDAY = new Date('2026-08-14T12:00:00-07:00');
const BANDCAMP_FRIDAY = new Date('2026-08-07T12:00:00-07:00');

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
    vi.useRealTimers();
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

  it('renders each main link as a platform pill with target and rel', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    const bandcampLink = document.querySelector('a.source-badge[href="https://kidlightbulbs.bandcamp.com"]');
    expect(bandcampLink).toBeTruthy();
    expect(bandcampLink!.getAttribute('target')).toBe('_blank');
    expect(bandcampLink!.getAttribute('rel')).toBe('noopener noreferrer');

    const patreonLink = document.querySelector('a.source-badge[href="https://patreon.com/kidlightbulbs"]');
    expect(patreonLink).toBeTruthy();
    // The row is a grid on phones and a wrapped flex row from `sm` up.
    expect(bandcampLink!.closest('.platform-pill-row')).toBeTruthy();
  });

  it('renders the payout percent on each pill', () => {
    expect(isBandcampFriday(ORDINARY_FRIDAY)).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(ORDINARY_FRIDAY);

    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('80-85%')).toBeTruthy();
    expect(screen.getByText('86-90%')).toBeTruthy();
  });

  it('shows Bandcamp\'s payout as ~97% on a Bandcamp Friday', () => {
    expect(isBandcampFriday(BANDCAMP_FRIDAY)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(BANDCAMP_FRIDAY);

    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('~97%')).toBeTruthy();
    expect(screen.queryByText('80-85%')).toBeNull();
    // Only Bandcamp waives its share — every other platform keeps its usual payout.
    expect(screen.getByText('86-90%')).toBeTruthy();
  });

  it('falls back to the "Link" pill for custom links with no display name', () => {
    const payload = {
      ...basePayload,
      links: [{ platform: 'other_1', url: 'https://example.com', displayName: null, payoutPercent: null, bandcampFriday: false }],
    };
    render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
    const link = document.querySelector('a.source-badge[href="https://example.com"]');
    expect(link).toBeTruthy();
    expect(link!.textContent).toContain('Link');
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

  it('renders a legacy divider inside a section as a rule above its link (pre-UNS-221 payload)', () => {
    // Two patronage links with the artist's rule between them — the rule survives as a
    // within-Patronage separator above Ko-fi.
    const legacyPayload = {
      ...basePayload,
      links: [
        { platform: 'patreon', url: 'https://patreon.com/kidlightbulbs', displayName: 'Patreon', payoutPercent: '86-90%', bandcampFriday: false },
        { platform: 'kofi', url: 'https://ko-fi.com/kidlightbulbs', displayName: 'Ko-fi', payoutPercent: '92-97%', bandcampFriday: false },
      ],
      linkDividers: [1],
    };
    render(<RichArtistProfile payload={legacyPayload} slug="kid-lightbulbs" />);
    const divider = document.querySelector('hr');
    expect(divider).toBeTruthy();
    // The divider starts a new row of pills; the link it points at leads that row.
    const nextRowLink = divider!.nextElementSibling?.querySelector('a.source-badge');
    expect(nextRowLink?.getAttribute('href')).toBe('https://ko-fi.com/kidlightbulbs');
  });

  it('subsumes a legacy divider at a section boundary into the section gap itself', () => {
    // Bandcamp (marketplaces) then Patreon (patronage) with the artist's rule between them:
    // the sections already separate them with headings, so no extra rule draws.
    const legacyPayload = {
      ...basePayload,
      links: [
        { platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com', displayName: 'Bandcamp', payoutPercent: '80-85%', bandcampFriday: false },
        { platform: 'patreon', url: 'https://patreon.com/kidlightbulbs', displayName: 'Patreon', payoutPercent: '86-90%', bandcampFriday: false },
      ],
      linkDividers: [1],
    };
    render(<RichArtistProfile payload={legacyPayload} slug="kid-lightbulbs" />);
    expect(screen.getByText('Patronage')).toBeTruthy();
    expect(screen.getByText('Marketplaces')).toBeTruthy();
    expect(document.querySelectorAll('hr').length).toBe(0);
  });

  it('does not render a divider before the first link', () => {
    render(<RichArtistProfile payload={{ ...basePayload, linkDividers: [0] }} slug="kid-lightbulbs" />);
    expect(document.querySelectorAll('hr').length).toBe(0);
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
    fireEvent.click(screen.getByRole('button', { name: 'Embed this profile' }));
    const codeBlock = document.querySelector('pre');
    expect(codeBlock).toBeTruthy();
    expect(codeBlock!.textContent).toContain('data-artist="Kid Lightbulbs"');
    expect(codeBlock!.textContent).toContain('/widget.js');
    expect(codeBlock!.textContent).toContain('class="unstream-widget"');
  });

  it('updates the embed code when theme or link count changes', () => {
    render(<RichArtistProfile payload={basePayload} slug="kid-lightbulbs" />);
    fireEvent.click(screen.getByRole('button', { name: 'Embed this profile' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Embed this profile' }));

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

  describe('tips', () => {
    it('shows no Tip section for an artist not taking tips', () => {
      render(<RichArtistProfile payload={{ ...basePayload, tips: { enabled: false, goals: [] } }} slug="kid-lightbulbs" />);
      expect(screen.queryByText('Tip directly')).toBeNull();
    });

    it('links Tip and each open goal to the tip page', () => {
      const payload = {
        ...basePayload,
        tips: { enabled: true, goals: [{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 120000, status: 'open' as const }] },
      };
      render(<MemoryRouter><RichArtistProfile payload={payload} slug="kid-lightbulbs" /></MemoryRouter>);
      expect(screen.getByText('Tip Kid Lightbulbs').closest('a')?.getAttribute('href')).toBe('/tip/kid-lightbulbs');
      expect(screen.getByText('Vinyl').closest('a')?.getAttribute('href')).toBe('/tip/kid-lightbulbs?goal=g1');
      expect(screen.getByText('$1,200.00 of $2,400.00')).toBeTruthy();
    });
  });

  describe('page sections (UNS-221)', () => {
    const claimedPayload = {
      ...basePayload,
      // bandcamp = marketplaces, patreon = patronage (both with sectionCategory in the web copy)
      tips: { enabled: true, goals: [] },
    };

    it('renders the default order: Patronage (tip first) → Bio → Featured → Marketplaces → Follow', () => {
      render(<MemoryRouter><RichArtistProfile payload={claimedPayload} slug="kid-lightbulbs" /></MemoryRouter>);
      const headings = [...document.querySelectorAll('h2')].map(h => h.textContent);
      const idx = (label: string) => headings.indexOf(label);
      expect(idx('Patronage')).toBeGreaterThanOrEqual(0);
      expect(idx('Bio')).toBeGreaterThan(idx('Patronage'));
      expect(idx('Featured Release')).toBeGreaterThan(idx('Bio'));
      expect(idx('Marketplaces')).toBeGreaterThan(idx('Featured Release'));
      expect(idx('Follow')).toBeGreaterThan(idx('Marketplaces'));
    });

    it('renders the Tip button inside the Patronage section, above any patronage platform', () => {
      render(<MemoryRouter><RichArtistProfile payload={claimedPayload} slug="kid-lightbulbs" /></MemoryRouter>);
      const patronageSection = screen.getByText('Patronage').closest('div')!;
      const sectionText = patronageSection.textContent ?? '';
      const tipIndex = sectionText.indexOf('Tip Kid Lightbulbs');
      const patreonIndex = sectionText.indexOf('Patreon');
      expect(tipIndex).toBeGreaterThanOrEqual(0);
      expect(patreonIndex).toBeGreaterThan(tipIndex);
    });

    it('renders sections in the payload sectionOrder when the artist rearranged them', () => {
      const payload = {
        ...basePayload,
        tips: { enabled: true, goals: [] } as const,
        sectionOrder: ['featured', 'social', 'marketplaces', 'patronage', 'bio'] as const,
      };
      render(<MemoryRouter><RichArtistProfile payload={payload as unknown as ArtistPagePayload} slug="kid-lightbulbs" /></MemoryRouter>);
      const headings = [...document.querySelectorAll('h2')].map(h => h.textContent);
      const idx = (label: string) => headings.indexOf(label);
      expect(idx('Featured Release')).toBeLessThan(idx('Follow'));
      expect(idx('Follow')).toBeLessThan(idx('Marketplaces'));
      expect(idx('Marketplaces')).toBeLessThan(idx('Patronage'));
      expect(idx('Patronage')).toBeLessThan(idx('Bio'));
    });

    it('renders the Tip above patronage links even when Patronage lands last', () => {
      const payload = {
        ...basePayload,
        tips: { enabled: true, goals: [] } as const,
        sectionOrder: ['bio', 'featured', 'marketplaces', 'social', 'patronage'] as const,
      };
      render(<MemoryRouter><RichArtistProfile payload={payload as unknown as ArtistPagePayload} slug="kid-lightbulbs" /></MemoryRouter>);
      const patronageSection = screen.getByText('Patronage').closest('div')!;
      const sectionText = patronageSection.textContent ?? '';
      expect(sectionText.indexOf('Tip Kid Lightbulbs')).toBeGreaterThanOrEqual(0);
      expect(sectionText.indexOf('Tip Kid Lightbulbs')).toBeLessThan(sectionText.indexOf('Patreon'));
    });

    it('skips empty sections (no Marketplaces heading when no marketplace links)', () => {
      const payload = {
        ...basePayload,
        // Patreon stays (patronage), bandcamp goes (no marketplaces left), no tips:
        // Marketplaces has nothing to show, Patronage has only Patreon — no tip.
        links: [{ platform: 'patreon', url: 'https://patreon.com/kidlightbulbs', displayName: 'Patreon', payoutPercent: '86-90%', bandcampFriday: false }],
        tips: { enabled: false, goals: [] },
      };
      render(<RichArtistProfile payload={payload} slug="kid-lightbulbs" />);
      expect(screen.queryByText('Marketplaces')).toBeNull();
      expect(screen.getByText('Patronage')).toBeTruthy();
    });

    it('shows the Patronage heading when only the Tip block is present (no patronage links)', () => {
      const payload = {
        ...basePayload,
        links: [{ platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com', displayName: 'Bandcamp', payoutPercent: '80-85%', bandcampFriday: false }],
        tips: { enabled: true, goals: [] },
      };
      render(<MemoryRouter><RichArtistProfile payload={payload} slug="kid-lightbulbs" /></MemoryRouter>);
      expect(screen.getByText('Patronage')).toBeTruthy();
      expect(screen.getByText('Tip Kid Lightbulbs')).toBeTruthy();
      expect(document.querySelector('a.source-badge[href="https://patreon.com/kidlightbulbs"]')).toBeNull();
    });

    it('derives official links into an Official section (not Marketplaces) on a sectioned payload', () => {
      // Sectioned payload as the new server sends it: faircamp in the official group.
      const payload = {
        ...basePayload,
        tips: { enabled: false, goals: [] },
        linkGroups: [
          {
            section: 'official' as const,
            links: [{ platform: 'faircamp', url: 'https://kid.example.faircamp.site', displayName: 'Faircamp', payoutPercent: '90-97%', bandcampFriday: false }],
            dividerIndexes: [],
          },
          {
            section: 'marketplaces' as const,
            links: [{ platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com', displayName: 'Bandcamp', payoutPercent: '80-85%', bandcampFriday: false }],
            dividerIndexes: [],
          },
        ],
      };
      render(<RichArtistProfile payload={payload as unknown as ArtistPagePayload} slug="kid-lightbulbs" />);
      expect(screen.getByText('Official')).toBeTruthy();
      expect(screen.getByText('Marketplaces')).toBeTruthy();
      expect(document.querySelector('a.source-badge[href="https://kid.example.faircamp.site"]')).toBeTruthy();
    });
  });
});
