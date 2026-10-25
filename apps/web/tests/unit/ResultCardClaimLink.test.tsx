// @vitest-environment jsdom
// Audit 2026-10-25 #6: the claim link rebuilt the slug with an ASCII-stripping regex, so Björk's
// card linked to /claim/bj-rk while the server's row is `bjork`. The link now uses only the slug
// the server sends (knownSlug), and a result without one has no row to claim, so it gets no link.

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
  it('uses the server-placed knownSlug', () => {
    expect(claimHref({ name: 'Björk', knownSlug: 'bjork' })).toBe('/claim/bjork');
  });

  it('never rebuilds a slug from the name', () => {
    expect(claimHref({ name: 'Björk', knownSlug: 'bjork-2' })).toBe('/claim/bjork-2');
  });

  it('offers no claim link when the server sent no slug, since there is no row to claim', () => {
    expect(claimHref({ name: 'Björk' })).toBeNull();
    cleanup();
    expect(claimHref({ name: '坂本龍一', matchConfidence: 'unverified' })).toBeNull();
  });

  it('offers no claim link on a claimed result', () => {
    expect(claimHref({ name: 'Björk', knownSlug: 'bjork', matchConfidence: 'claimed' })).toBeNull();
  });
});
