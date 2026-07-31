// @vitest-environment jsdom
// The "Unverified match" banner claims a comparison — "the same X as the other
// results" — so it may only appear when a comparison actually happened.
//
// The bug this guards: searching "viagra boys" returned exactly one card, built
// from MusicBrainz alone because no platform matched, and it carried that banner.
// There were no other results to be the same or different from, so the copy read
// as a warning about a result nothing was actually in doubt about.
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

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'viagraboys',
    name: 'Viagra Boys',
    type: 'artist',
    platforms: [{ sourceId: 'officialsite', url: 'https://vboysstockholm.com/' }],
    ...overrides,
  };
}

const render = (ui: React.ReactElement) => renderComponent(<MemoryRouter>{ui}</MemoryRouter>);

describe('ResultCard unverified banner', () => {
  afterEach(cleanup);

  it('warns when the result was split off for having conflicting releases', () => {
    render(<ResultCard result={makeResult({
      matchConfidence: 'unverified',
      unverifiedReason: 'conflicting-releases',
    })} />);

    expect(screen.getByText('Unverified match:')).toBeTruthy();
  });

  it('stays quiet for a MusicBrainz-only card with nothing to compare against', () => {
    render(<ResultCard result={makeResult({
      matchConfidence: 'unverified',
      unverifiedReason: 'no-release-data',
    })} />);

    expect(screen.queryByText('Unverified match:')).toBeNull();
    // The header chip still marks the result as unverified — the point is that
    // low confidence gets a quiet label, not a warning about a conflict.
    expect(screen.getByText('Unverified')).toBeTruthy();
  });

  it('stays quiet when the reason is missing, as for artists restored from the DB', () => {
    render(<ResultCard result={makeResult({ matchConfidence: 'unverified' })} />);

    expect(screen.queryByText('Unverified match:')).toBeNull();
  });

  it('shows nothing for a verified result', () => {
    render(<ResultCard result={makeResult({ matchConfidence: 'verified' })} />);

    expect(screen.queryByText('Unverified match:')).toBeNull();
    expect(screen.queryByText('Unverified')).toBeNull();
  });
});
