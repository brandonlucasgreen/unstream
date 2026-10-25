// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardActions } from 'src/components/ResultCardActions';
import type { SearchResult } from 'src/types';

vi.mock('src/services/analytics', () => ({
  analytics: { trackReportIssue: vi.fn() },
}));

function renderActions(result: Partial<SearchResult>) {
  return render(
    <MemoryRouter>
      <ResultCardActions result={result as SearchResult} />
    </MemoryRouter>
  );
}

afterEach(cleanup);

const base: Partial<SearchResult> = {
  id: 'test-1',
  name: 'Test Artist',
  type: 'artist',
  matchConfidence: 'verified',
  platforms: [],
};

describe('ResultCardActions claim link (audit 2026-10-25 #6)', () => {
  it('links to the canonical server slug, not a client-regenerated one', () => {
    renderActions({ ...base, name: 'Björk', knownSlug: 'bjork' });
    const link = screen.getByText(/Are you Björk\?/).closest('a');
    // The old client regex produced /claim/bj-rk for this name.
    expect(link?.getAttribute('href')).toBe('/claim/bjork');
  });

  it('prefers claimedSlug over knownSlug, as the save path does', () => {
    renderActions({ ...base, claimedSlug: 'bjork', knownSlug: 'old-bjork' });
    const link = screen.getByText(/Are you/).closest('a');
    expect(link?.getAttribute('href')).toBe('/claim/bjork');
  });

  it('renders no claim link for a non-Latin name with no slug, rather than a mangled address', () => {
    // The client regex collapsed this name to an empty slug (/claim/), and the
    // server-side canonical slug for it is derived from stored rows the card
    // doesn't know — so without a slug there is nothing to link to.
    renderActions({ ...base, name: '坂本龍一' });
    expect(screen.queryByText(/Claim your artist page/)).toBeNull();
  });

  it('renders no claim link for a claimed result', () => {
    renderActions({ ...base, knownSlug: 'bjork', matchConfidence: 'claimed' });
    expect(screen.queryByText(/Claim your artist page/)).toBeNull();
  });
});
