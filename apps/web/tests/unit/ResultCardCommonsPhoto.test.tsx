// @vitest-environment jsdom
// A Wikimedia Commons photo is CC BY / BY-SA, which means its author and licence must be shown
// wherever it is. The card may only show the photo with that credit, and only when it has no
// photo of its own.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as renderComponent, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCard } from 'src/components/ResultCard';
import type { SearchResult } from 'src/types';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: null,
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

const COMMONS_PHOTO = {
  url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Zoe_Keating.jpg/330px-Zoe_Keating.jpg',
  author: 'PopTech from Camden, Maine and Brooklyn, NY, USA',
  license: 'CC BY-SA 2.0',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Zoe_Keating_-_Pop!Tech_2009_-_Camden,_ME.jpg',
};

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'mb-zoekeating',
    name: 'Zoë Keating',
    type: 'artist',
    platforms: [{ sourceId: 'officialsite', url: 'http://www.zoekeating.com/' }],
    ...overrides,
  };
}

const render = (ui: React.ReactElement) => renderComponent(<MemoryRouter>{ui}</MemoryRouter>);

describe('ResultCard Commons photo', () => {
  afterEach(cleanup);

  it('shows the photo with its author and licence, linked to the Commons file page', () => {
    render(<ResultCard result={makeResult({ commonsPhoto: COMMONS_PHOTO })} />);

    expect(screen.getByAltText('Zoë Keating').getAttribute('src')).toBe(COMMONS_PHOTO.url);
    const credit = screen.getByRole('link', { name: /Photo: PopTech/ });
    expect(credit.getAttribute('href')).toBe(COMMONS_PHOTO.sourceUrl);
    expect(credit.textContent).toContain('CC BY-SA 2.0');
  });

  it("shows the card's own photo, and no credit, when it has one", () => {
    render(<ResultCard result={makeResult({ imageUrl: 'https://f4.bcbits.com/img/1.jpg', commonsPhoto: COMMONS_PHOTO })} />);

    expect(screen.getByAltText('Zoë Keating').getAttribute('src')).toBe('https://f4.bcbits.com/img/1.jpg');
    expect(screen.queryByText(/Photo:/)).toBeNull();
  });
});
