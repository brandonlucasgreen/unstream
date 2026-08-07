// @vitest-environment jsdom
// Which key a search-result card saves an artist under.
//
// The bug this guards, found 2026-08-07: the card saved under `result.id` — a search-pipeline key
// like `rodneyowl`, `nameonly-…` or `qobuz-pearljam` — which matches no row in the artists table.
// `saved-artists.ts` resolves the artist by exactly that value, so the save was written with
// `artist_id: null`, and every feature keyed on the artist went blind to it: the release feeds,
// the /dashboard shortlist, and the `requestArtistCatalog` call that makes a save the strongest
// signal to crawl someone. 25 of 37 live rows in production were in that state.
//
// The slug was already in the payload as `knownSlug` — `attachArtistPageSlugs` puts it on every
// placeable result, server-side, precisely so no client has to derive it.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCard } from 'src/components/ResultCard';
import type { SearchResult } from 'src/types';

const saveArtist = vi.fn();
const removeSavedArtist = vi.fn();
let savedKeys: string[] = [];

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: 'u1' } },
    isArtistSaved: (key: string) => savedKeys.includes(key),
    saveArtist,
    removeSavedArtist,
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
    // The shape that caused the bug: a platform-derived handle, no hyphen.
    id: 'rodneyowl',
    name: 'Rodney Owl',
    type: 'artist',
    matchConfidence: 'verified',
    knownSlug: 'rodney-owl',
    platforms: [{ sourceId: 'bandcamp', url: 'https://rodneyowl.bandcamp.com' }],
    ...overrides,
  } as SearchResult;
}

function show(result: SearchResult) {
  render(
    <MemoryRouter>
      <ResultCard result={result} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  saveArtist.mockClear();
  removeSavedArtist.mockClear();
  savedKeys = [];
});
afterEach(cleanup);

describe('the key a result card saves under', () => {
  it('saves an unclaimed-but-known artist under knownSlug, not the synthetic id', () => {
    show(makeResult());
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(saveArtist).toHaveBeenCalledTimes(1);
    expect(saveArtist.mock.calls[0][0]).toBe('rodney-owl');
  });

  it('still prefers claimedSlug for a claimed artist', () => {
    show(makeResult({ matchConfidence: 'claimed', claimedSlug: 'kid-lightbulbs', knownSlug: undefined, id: 'claimed-kid-lightbulbs' }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(saveArtist.mock.calls[0][0]).toBe('kid-lightbulbs');
  });

  it('falls back to the id when the server sent no slug at all', () => {
    show(makeResult({ knownSlug: undefined, claimedSlug: undefined }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(saveArtist.mock.calls[0][0]).toBe('rodneyowl');
  });

  // The invariant that was actually broken: the card linked to /artist/rodney-owl while saving
  // under `rodneyowl`. One card, one identity for the artist.
  it('saves under the same slug it links the artist page to', () => {
    show(makeResult());

    const link = screen.getByRole('link', { name: /view artist page/i });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(link.getAttribute('href')).toBe('/artist/rodney-owl');
    expect(saveArtist.mock.calls[0][0]).toBe('rodney-owl');
  });

  // Saved-state used to be derived by a second copy of the same expression. Fixing only the save
  // path would leave the heart dark on an artist you had just saved.
  it('reads saved state under the same key it saves with', () => {
    savedKeys = ['rodney-owl'];
    show(makeResult());

    expect(screen.getByRole('button', { name: /saved/i })).toBeTruthy();
  });

  it('removes under the same key too', () => {
    savedKeys = ['rodney-owl'];
    show(makeResult());
    fireEvent.click(screen.getByRole('button', { name: /saved/i }));

    expect(removeSavedArtist).toHaveBeenCalledWith('rodney-owl');
  });
});
