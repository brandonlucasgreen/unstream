// @vitest-environment jsdom
// The "find your page" search on /for-artists: one row per artist, linking to the claim flow for
// an unclaimed artist with a stored row and to the page for a claimed one.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SearchResult } from 'src/types';

const fetchStoredArtists = vi.fn();
const searchArtistsToClaim = vi.fn();

vi.mock('src/services/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/services/sources')>();
  return {
    ...actual,
    fetchStoredArtists: (query: string) => fetchStoredArtists(query),
    searchArtistsToClaim: (query: string) => searchArtistsToClaim(query),
  };
});

const { ClaimSearch } = await import('src/components/ClaimSearch');
const { claimRows } = await import('src/components/ClaimSearchUtils');
const { SearchRequestError } = await import('src/services/sources');

function artist(overrides: Partial<SearchResult>): SearchResult {
  return { id: 'x', name: 'Paracosm', type: 'artist', platforms: [], matchConfidence: 'verified', ...overrides } as SearchResult;
}

describe('claimRows', () => {
  it('links an unclaimed artist with a stored row into the claim flow', () => {
    const [row] = claimRows([artist({ knownSlug: 'xparacosm' })]);
    expect(row.action).toEqual({ kind: 'claim', href: '/claim/xparacosm' });
  });

  it('links a claimed artist to their page instead', () => {
    const [row] = claimRows([artist({ matchConfidence: 'claimed', claimedSlug: 'paracosm-orlando', knownSlug: 'paracosm-orlando' })]);
    expect(row.action).toEqual({ kind: 'claimed', href: '/a/paracosm-orlando' });
  });

  it('drops artists with no stored slug, and anything that is not an artist', () => {
    expect(claimRows([
      artist({}),
      artist({ type: 'album', knownSlug: 'some-album' }),
    ])).toEqual([]);
  });

  it('names the stores, not the socials, once each', () => {
    const [row] = claimRows([artist({
      knownSlug: 'xparacosm',
      location: { city: 'Los Angeles', countryCode: 'US' },
      platforms: [
        { sourceId: 'instagram', url: 'https://instagram.com/x' },
        { sourceId: 'bandcamp', url: 'https://xparacosm.bandcamp.com' },
        { sourceId: 'bandcamp', url: 'https://xparacosm.bandcamp.com/music' },
        { sourceId: 'kofi', url: 'https://ko-fi.com/x' },
      ],
    })]);
    expect(row.platformNames).toEqual(['Bandcamp', 'Ko-fi']);
    expect(row.location).toBe('Los Angeles, US');
  });
});

describe('ClaimSearch', () => {
  beforeEach(() => {
    fetchStoredArtists.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function search(name: string) {
    render(<MemoryRouter><ClaimSearch /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Your artist name'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Find my page' }));
  }

  it('shows a Claim button for each claimable artist', async () => {
    searchArtistsToClaim.mockResolvedValue({ results: [artist({ knownSlug: 'xparacosm' })] });
    search('Paracosm');
    const link = await screen.findByRole('link', { name: 'Claim this page' });
    expect(link.getAttribute('href')).toBe('/claim/xparacosm');
    expect(searchArtistsToClaim).toHaveBeenCalledWith('Paracosm');
  });

  it('keeps stored artists on screen when the full search comes back empty', async () => {
    fetchStoredArtists.mockResolvedValue([artist({ matchConfidence: 'claimed', claimedSlug: 'paracosm' })]);
    let finish!: (value: unknown) => void;
    searchArtistsToClaim.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    search('Paracosm');
    await screen.findByRole('link', { name: '✓ Claimed' });
    finish({ results: [] });
    await screen.findByRole('link', { name: '✓ Claimed' });
    expect(screen.queryByText(/No page for that name yet/)).toBeNull();
  });

  it('says so, and points to contact, when nobody matches', async () => {
    searchArtistsToClaim.mockResolvedValue({ results: [] });
    search('Nobody Yet');
    await screen.findByText(/No page for that name yet/);
    expect(screen.getByRole('link', { name: 'tell me where' }).getAttribute('href')).toBe('/contact');
  });

  it('tells a rate-limited artist to wait rather than that they are missing', async () => {
    searchArtistsToClaim.mockRejectedValue(new SearchRequestError('Search API error: 429', 429));
    search('Paracosm');
    await screen.findByText(/Try again in a minute/);
    expect(screen.queryByText(/No page for that name yet/)).toBeNull();
  });
});
