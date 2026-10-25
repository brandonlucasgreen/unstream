// @vitest-environment jsdom
// Audit 2026-10-25 #6: the claim link rebuilt the slug with an ASCII-stripping regex, so Björk's
// card linked to /claim/bj-rk while the server's row is `bjork`, and a non-Latin name produced
// /claim/. The link now uses the server's slug: knownSlug when present, else the shared artistSlug.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardActions } from 'src/components/ResultCardActions';
import type { SearchResult } from 'src/types';

vi.mock('src/services/analytics', () => ({ analytics: { trackReportIssue: vi.fn() } }));

function claimHref(overrides: Partial<SearchResult>): string | null {
  render(
    <MemoryRouter>
      <ResultCardActions result={{ id: 'x', type: 'artist', platforms: [], matchConfidence: 'verified', ...overrides } as SearchResult} />
    </MemoryRouter>
  );
  return screen.queryByRole('link', { name: /claim your artist page/i })?.getAttribute('href') ?? null;
}

afterEach(cleanup);

describe('the claim link', () => {
  it('uses the server-placed knownSlug first', () => {
    expect(claimHref({ name: 'Björk', knownSlug: 'bjork-2' })).toBe('/claim/bjork-2');
  });

  it('folds accents like the server when there is no knownSlug', () => {
    expect(claimHref({ name: 'Björk' })).toBe('/claim/bjork');
    cleanup();
    expect(claimHref({ name: 'Sébastien Tellier' })).toBe('/claim/sebastien-tellier');
  });

  it('keeps letters NFD cannot decompose', () => {
    expect(claimHref({ name: 'Łukasz' })).toBe('/claim/lukasz');
  });

  it('offers no claim link for a name with nothing to slug', () => {
    expect(claimHref({ name: '坂本龍一' })).toBeNull();
  });
});
