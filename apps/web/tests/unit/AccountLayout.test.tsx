// @vitest-environment jsdom
// The shell every signed-in page renders inside. What's worth locking:
//
// - the nav lists the account areas, and Settings is one of them (it left the header, so this
//   is now the only place it appears for a non-admin);
// - a claimed artist's sub-items appear only while you're on that artist, which is what keeps
//   the sidebar from growing three rows per artist;
// - signed out redirects rather than rendering an account page with no data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockUseAuth = vi.fn();
vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));

import { AccountLayout } from 'src/components/AccountLayout';

const loadClaimedProfiles = vi.fn();

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { access_token: 'token' },
    isLoading: false,
    claimedProfiles: [],
    loadClaimedProfiles,
    ...overrides,
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={<AccountLayout title="Dashboard"><p>page body</p></AccountLayout>}
        />
      </Routes>
    </MemoryRouter>
  );
}

/** The nav renders twice (sidebar + mobile strip), so assert on hrefs, not on one element. */
function navHrefs() {
  return Array.from(document.querySelectorAll('nav[aria-label="Account"] a'))
    .map(a => a.getAttribute('href'));
}

describe('AccountLayout', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue(auth());
    loadClaimedProfiles.mockReset();
  });

  afterEach(cleanup);

  it('lists the account areas, including Settings', () => {
    renderAt('/dashboard');
    const hrefs = new Set(navHrefs());
    expect(hrefs.has('/dashboard')).toBe(true);
    expect(hrefs.has('/collection')).toBe(true);
    expect(hrefs.has('/saved')).toBe(true);
    expect(hrefs.has('/settings')).toBe(true);
    expect(screen.getByText('page body')).not.toBeNull();
  });

  it('marks the current area as the current page', () => {
    renderAt('/collection');
    const current = Array.from(document.querySelectorAll('a[aria-current="page"]'))
      .map(a => a.getAttribute('href'));
    expect(current).toContain('/collection');
    expect(current).not.toContain('/dashboard');
  });

  it('loads the claimed profiles once, and lists them when there are any', () => {
    mockUseAuth.mockReturnValue(auth({
      claimedProfiles: [{ id: '1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs' }],
    }));
    renderAt('/dashboard');

    expect(loadClaimedProfiles).toHaveBeenCalledTimes(1);
    expect(navHrefs()).toContain('/artist-edit/kid-lightbulbs');
    // Not on this artist, so its sub-items stay collapsed.
    expect(navHrefs()).not.toContain('/artist-edit/kid-lightbulbs/releases');
  });

  it("expands an artist's sub-items while you're on that artist", () => {
    mockUseAuth.mockReturnValue(auth({
      claimedProfiles: [{ id: '1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs' }],
    }));
    renderAt('/artist-edit/kid-lightbulbs/releases');

    const hrefs = navHrefs();
    expect(hrefs).toContain('/artist-edit/kid-lightbulbs/releases');
    expect(hrefs).toContain('/a/kid-lightbulbs');
  });

  it('redirects to login when there is no session', () => {
    mockUseAuth.mockReturnValue(auth({ session: null }));
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<AccountLayout title="Settings"><p>page body</p></AccountLayout>} />
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('login page')).not.toBeNull();
    expect(screen.queryByText('page body')).toBeNull();
  });
});
