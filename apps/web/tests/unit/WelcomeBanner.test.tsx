// @vitest-environment jsdom
// The dashboard welcome for new accounts.
//
// Sign-up is a magic link, and it used to drop a new fan on the home page with no sign
// anything had happened. The banner fixes that, but it has two ways to go wrong: greeting
// every pre-existing account as a newcomer (hence the sign-up window), and coming back after
// it was dismissed (hence the flag on the account, not just component state).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { shouldShowWelcome, WELCOME_WINDOW_DAYS, WELCOME_DISMISSED_KEY } from 'src/utils/welcome';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  dismissWelcome: vi.fn(),
}));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => mocks.useAuth() }));
vi.mock('src/services/auth', () => ({ dismissWelcome: () => mocks.dismissWelcome() }));

import { WelcomeBanner } from 'src/components/WelcomeBanner';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-27T12:00:00Z');

function makeUser(createdAt: string, userMetadata: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    email: 'fan@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: userMetadata,
    created_at: createdAt,
  } as User;
}

describe('shouldShowWelcome', () => {
  it('greets an account created moments ago', () => {
    expect(shouldShowWelcome(makeUser(new Date(NOW - 60_000).toISOString()), NOW)).toBe(true);
  });

  it('still greets an account a few days old that has not dismissed it', () => {
    expect(shouldShowWelcome(makeUser(new Date(NOW - 3 * DAY).toISOString()), NOW)).toBe(true);
  });

  it('does not greet an account older than the window', () => {
    const created = new Date(NOW - (WELCOME_WINDOW_DAYS + 1) * DAY).toISOString();
    expect(shouldShowWelcome(makeUser(created), NOW)).toBe(false);
  });

  it('does not greet an account that dismissed it', () => {
    const user = makeUser(new Date(NOW - 60_000).toISOString(), {
      [WELCOME_DISMISSED_KEY]: new Date(NOW).toISOString(),
    });
    expect(shouldShowWelcome(user, NOW)).toBe(false);
  });

  it('keeps other metadata from counting as a dismissal', () => {
    const user = makeUser(new Date(NOW - 60_000).toISOString(), { has_password: true });
    expect(shouldShowWelcome(user, NOW)).toBe(true);
  });

  it('shows nothing without a user or with an unreadable creation date', () => {
    expect(shouldShowWelcome(null, NOW)).toBe(false);
    expect(shouldShowWelcome(makeUser('not a date'), NOW)).toBe(false);
  });
});

describe('WelcomeBanner', () => {
  beforeEach(() => {
    mocks.dismissWelcome.mockReset();
    mocks.dismissWelcome.mockResolvedValue({ error: null });
  });

  afterEach(cleanup);

  function renderBanner(user: User | null) {
    mocks.useAuth.mockReturnValue({ user });
    return render(
      <MemoryRouter>
        <WelcomeBanner />
      </MemoryRouter>
    );
  }

  it('renders for a new account', () => {
    renderBanner(makeUser(new Date().toISOString()));
    expect(screen.getByRole('heading', { name: 'Welcome to Unstream' })).toBeTruthy();
  });

  it('renders nothing for an established account', () => {
    const { container } = renderBanner(makeUser(new Date(Date.now() - 30 * DAY).toISOString()));
    expect(container.innerHTML).toBe('');
  });

  it('hides on dismiss and records the dismissal on the account', () => {
    renderBanner(makeUser(new Date().toISOString()));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss welcome message' }));

    expect(screen.queryByRole('heading', { name: 'Welcome to Unstream' })).toBeNull();
    expect(mocks.dismissWelcome).toHaveBeenCalledTimes(1);
  });
});
