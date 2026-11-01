// @vitest-environment jsdom
// The one-time two-step-verification nudge on /my-collection. It must show
// only for an account with no second factor, never come back after dismissal
// (the flag is on the account, so it holds across devices), and link to the
// /settings section that does the enrolling.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { SecurityNudgeBanner } from 'src/components/SecurityNudgeBanner';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  dismissSecurityNudge: vi.fn(),
}));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => mocks.useAuth() }));
vi.mock('src/services/auth', () => ({ dismissSecurityNudge: () => mocks.dismissSecurityNudge() }));

import { SECURITY_NUDGE_DISMISSED_KEY } from 'src/utils/securityNudge';

function makeUser(factors: { status: string }[] = [], userMetadata: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    email: 'fan@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: userMetadata,
    created_at: '2026-06-01T00:00:00Z',
    factors,
  } as unknown as User;
}

function renderBanner(user: User | null) {
  mocks.useAuth.mockReturnValue({ user });
  return render(
    <MemoryRouter>
      <SecurityNudgeBanner />
    </MemoryRouter>,
  );
}

describe('SecurityNudgeBanner', () => {
  beforeEach(() => {
    mocks.dismissSecurityNudge.mockReset().mockResolvedValue({ error: null });
  });

  afterEach(cleanup);

  it('renders for an account with no second factor, linking to the settings section', () => {
    renderBanner(makeUser());
    expect(screen.getByRole('heading', { name: 'Safeguard your account' })).toBeTruthy();
    const link = screen.getByText('Set it up');
    expect(link.getAttribute('href')).toBe('/settings#two-step');
  });

  it('renders nothing once a verified factor exists', () => {
    const { container } = renderBanner(makeUser([{ status: 'verified' }]));
    expect(container.innerHTML).toBe('');
  });

  it('renders while only an unverified factor exists', () => {
    renderBanner(makeUser([{ status: 'unverified' }]));
    expect(screen.getByRole('heading', { name: 'Safeguard your account' })).toBeTruthy();
  });

  it('renders nothing after dismissal', () => {
    const { container } = renderBanner(
      makeUser([], { [SECURITY_NUDGE_DISMISSED_KEY]: '2026-11-01T00:00:00Z' }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('hides on dismiss and records the dismissal on the account', () => {
    renderBanner(makeUser());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss account security suggestion' }));

    expect(screen.queryByRole('heading', { name: 'Safeguard your account' })).toBeNull();
    expect(mocks.dismissSecurityNudge).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without a user', () => {
    const { container } = renderBanner(null);
    expect(container.innerHTML).toBe('');
  });
});
