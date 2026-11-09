// @vitest-environment jsdom
// The Embed widget tab of /promote/:slug: the artist page's embed customiser, fed from the same
// public artist-page payload, without the panel's own heading.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  value: { session: { access_token: 'tok', user: { id: 'u1' } } as unknown, isLoading: false },
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { PromoteEmbedPage } from 'src/pages/PromoteEmbedPage';
import { PromoteTabs } from 'src/components/PromoteTabs';

const payload = {
  artist: { id: 'a1', slug: 'xkidlightbulbs', name: 'Kid Lightbulbs', imageUrl: null, matchConfidence: 'claimed' },
  profile: null,
  links: [
    { platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com', displayName: null, payoutPercent: null, bandcampFriday: false },
    { platform: 'subvert', url: 'https://subvert.fm/kidlightbulbs', displayName: null, payoutPercent: null, bandcampFriday: false },
  ],
  socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/kidlightbulbs', displayName: null }],
  bandcampFriday: false,
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/promote/kid-lightbulbs/embed']}>
      <Routes>
        <Route path="/promote/:slug/embed" element={<PromoteEmbedPage />} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe('PromoteEmbedPage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    auth.value = { session: { access_token: 'tok', user: { id: 'u1' } }, isLoading: false };
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the artist's page links, socials included, and embeds the page's canonical slug", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) });
    renderPage();

    await screen.findByText('Embed preview');
    expect(fetchMock).toHaveBeenCalledWith('/api/artist-page?slug=kid-lightbulbs');
    expect(screen.getByRole('checkbox', { name: 'Bandcamp' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Subvert' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeTruthy();
    expect(document.querySelector('pre')!.textContent).toContain('data-slug="xkidlightbulbs"');
    // The tab already says what this is, so the panel's own heading is left out.
    expect(screen.queryByText('Embed this profile on your website')).toBeNull();
  });

  it('says so when the links cannot be loaded', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    renderPage();
    expect(await screen.findByText(/Couldn’t load your links/)).toBeTruthy();
  });

  it('sends a signed-out visitor to sign in, and back to this tab', async () => {
    auth.value = { session: null, isLoading: false };
    renderPage();
    await screen.findByText('Login page');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a tab of the Promote page', () => {
    render(
      <MemoryRouter initialEntries={['/promote/kid-lightbulbs/embed']}>
        <Routes>
          <Route path="/promote/:slug/*" element={<PromoteTabs slug="kid-lightbulbs" />} />
        </Routes>
      </MemoryRouter>,
    );
    const tab = screen.getByRole('link', { name: 'Embed widget' });
    expect(tab.getAttribute('href')).toBe('/promote/kid-lightbulbs/embed');
    expect(tab.getAttribute('aria-current')).toBe('page');
  });
});
