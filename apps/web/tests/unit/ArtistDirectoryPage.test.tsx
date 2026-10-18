// @vitest-environment jsdom
// UNS-223: the /artists header invites artists without a profile to claim theirs.
//
// What's worth locking: the claim CTA renders only on the Indie Artist Index (/artists)
// and only after the directory loads (it appears with the count), while the sibling
// "Artists You Know" page (/known-artists) — the unclaimed pre-generated index —
// stays CTA-free since those artists don't have a page to claim.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistDirectoryPage } from 'src/pages/ArtistDirectoryPage';
import { KnownArtistsPage } from 'src/pages/KnownArtistsPage';

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ artists: [] }), { headers: { 'content-type': 'application/json' } }),
));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(page: React.ReactElement) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

describe('ArtistDirectoryPage claim CTA (UNS-223)', () => {
  it('shows the claim-invitation copy once the directory has loaded', async () => {
    renderPage(<ArtistDirectoryPage />);

    // Loads with the count, not before — the CTA belongs with real content.
    expect(screen.queryByText(/Are you an independent human artist\?/)).toBeNull();
    expect(await screen.findByText(/Are you an independent human artist\?/)).toBeTruthy();
    expect(screen.getByText(/Claim your Unstream page by searching for it above/)).toBeTruthy();
    const cta = screen.getByText(/Are you an independent human artist\?/).closest('p')!;
    expect(cta.textContent).toBe(
      'Are you an independent human artist? Claim your Unstream page by searching for it above, then clicking the \u201cClaim your artist page\u201d link.',
    );

    const subtitle = screen.getByText(/verified artists? on platforms that pay fairly/);
    expect(subtitle.textContent).toBe('0 verified artists on platforms that pay fairly');
  });

  it('does not show the claim CTA on the unclaimed Artists You Know index', async () => {
    renderPage(<KnownArtistsPage />);

    expect(await screen.findByText(/you know .* music available for direct purchase/)).toBeTruthy();
    expect(screen.queryByText(/independent human artist/)).toBeNull();
  });
});