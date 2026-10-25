// @vitest-environment jsdom
// UNS-223: the /artists header invites artists without a profile to claim theirs.
//
// What's worth locking: the claim CTA renders only on the Indie Artist Index (/artists)
// and only after the directory loads (it appears with the count), while the sibling
// "Artists You Know" page (/known-artists) — the unclaimed pre-generated index —
// stays CTA-free since those artists don't have a page to claim.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistDirectoryPage } from 'src/pages/ArtistDirectoryPage';
import { KnownArtistsPage } from 'src/pages/KnownArtistsPage';

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
// A fresh Response per call (a body can be read once), stubbed before every test: stubbing once
// at module level left the second test on the real fetch, whose failure the page used to render
// as "0 artists" — which is how that test passed.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ artists: [] }), { headers: { 'content-type': 'application/json' } }),
  ));
});

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
// Audit 2026-10-25 #7: a failed load used to fall through to "0 verified artists".
describe('ArtistIndexPage when the directory fails to load', () => {
  it('says it could not load, with a retry, instead of reporting zero artists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ artists: [{ slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null }] }), {
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage(<ArtistDirectoryPage />);

    expect((await screen.findByRole('alert')).textContent).toContain("couldn't load");
    expect(screen.queryByText(/0 verified artists/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 verified artist on platforms that pay fairly')).toBeTruthy();
  });
});
