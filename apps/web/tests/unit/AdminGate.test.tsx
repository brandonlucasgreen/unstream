// @vitest-environment jsdom
// Every /admin/* page waits for auth before deciding who is looking. Each one used to check
// `isAdmin` alone, which is false while the session is still loading, so the admin saw
// "Not authorized." on every direct load.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  value: { isAdmin: false, isLoading: true, session: null as { access_token: string } | null },
}));

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => auth.value,
}));
vi.mock('../../src/components/Header', () => ({ Header: () => <div data-testid="header" /> }));
vi.mock('../../src/components/AppFallback', () => ({
  AppLoadingFallback: () => <div data-testid="loading" />,
}));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { AdminGate } from '../../src/components/AdminGate';
import { AdminLinksPage } from '../../src/pages/AdminLinksPage';
import { AdminFlagsPage } from '../../src/pages/AdminFlagsPage';
import { AdminMergePage } from '../../src/pages/AdminMergePage';
import { AdminVerifyPage } from '../../src/pages/AdminVerifyPage';
import { AdminReleaseReviewPage } from '../../src/pages/AdminReleaseReviewPage';
import { AdminTipsPage } from '../../src/pages/AdminTipsPage';

const PAGES = [
  ['/admin/links', AdminLinksPage],
  ['/admin/flags', AdminFlagsPage],
  ['/admin/merge', AdminMergePage],
  ['/admin/verify', AdminVerifyPage],
  ['/admin/release-review', AdminReleaseReviewPage],
  ['/admin/tips', AdminTipsPage],
] as const;

describe('AdminGate', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  afterEach(cleanup);

  it('shows the page to the admin', () => {
    auth.value = { isAdmin: true, isLoading: false, session: { access_token: 'admin-token' } };
    render(<AdminGate><p>The page</p></AdminGate>);
    expect(screen.getByText('The page')).toBeTruthy();
  });

  it('says "Not authorized." to anyone else, once auth has loaded', () => {
    auth.value = { isAdmin: false, isLoading: false, session: { access_token: 'fan-token' } };
    render(<AdminGate><p>The page</p></AdminGate>);
    expect(screen.getByText('Not authorized.')).toBeTruthy();
    expect(screen.queryByText('The page')).toBeNull();
  });

  it('shows neither while auth is loading', () => {
    auth.value = { isAdmin: false, isLoading: true, session: null };
    render(<AdminGate><p>The page</p></AdminGate>);
    expect(screen.getByTestId('loading')).toBeTruthy();
    expect(screen.queryByText('Not authorized.')).toBeNull();
    expect(screen.queryByText('The page')).toBeNull();
  });

  describe.each(PAGES)('%s', (_path, Page) => {
    it('does not say "Not authorized." while auth is loading, and asks the server nothing', () => {
      auth.value = { isAdmin: false, isLoading: true, session: null };
      render(<MemoryRouter><Page /></MemoryRouter>);
      expect(screen.getByTestId('loading')).toBeTruthy();
      expect(screen.queryByText('Not authorized.')).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('says "Not authorized." to a signed-in account that is not the admin, and asks the server nothing', () => {
      auth.value = { isAdmin: false, isLoading: false, session: { access_token: 'fan-token' } };
      render(<MemoryRouter><Page /></MemoryRouter>);
      expect(screen.getByText('Not authorized.')).toBeTruthy();
      expect(screen.queryByTestId('header')).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
