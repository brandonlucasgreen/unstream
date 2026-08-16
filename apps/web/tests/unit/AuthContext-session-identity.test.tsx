// @vitest-environment jsdom
//
// Supabase re-emits the session on tab focus, cross-tab sync and token refresh, and its
// INITIAL_SESSION event arrives just after init() has already set an identical one. Every
// emission is a fresh object, so `session` used to change identity each time and re-fire every
// `[session]` effect in the app. /settings has six of them, which is how a single page load
// spent twelve requests of a shared 30/min budget and 429'd on itself (UNSTREAM-WEB-12).
//
// These pin the identity contract: same token in, same object out.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from 'src/contexts/AuthContext';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: vi.fn(),
      signInWithOtp: vi.fn(),
      signInWithPassword: vi.fn(),
    },
  }),
  waitForMagicLinkSession: vi.fn(),
}));

function makeSession(accessToken: string, userMetadata: Record<string, unknown> = {}) {
  return {
    access_token: accessToken,
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1_000_000,
    user: {
      id: 'user-1',
      email: 'fan@example.com',
      aud: 'authenticated',
      role: 'authenticated',
      user_metadata: userMetadata,
    },
  };
}

// Stands in for the six panels on /settings: one fetch, keyed on the session object.
const sessionEffectRuns = { count: 0 };
const tokensSeen: (string | null)[] = [];
const hasPasswordSeen: boolean[] = [];
function Panel() {
  const { session, hasPassword } = useAuth();
  tokensSeen.push(session?.access_token ?? null);
  hasPasswordSeen.push(hasPassword);
  useEffect(() => {
    if (session) sessionEffectRuns.count += 1;
  }, [session]);
  return null;
}

let emitAuthEvent: (event: string, session: unknown) => void;

describe('AuthContext session identity', () => {
  beforeEach(() => {
    sessionEffectRuns.count = 0;
    tokensSeen.length = 0;
    hasPasswordSeen.length = 0;
    mocks.getSession.mockReset();
    mocks.onAuthStateChange.mockReset();
    mocks.onAuthStateChange.mockImplementation((cb: (e: string, s: unknown) => void) => {
      emitAuthEvent = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  });

  afterEach(() => {
    cleanup();
  });

  async function renderSignedIn() {
    mocks.getSession.mockResolvedValue({ data: { session: makeSession('token-abc') } });
    render(<AuthProvider><Panel /></AuthProvider>);
    await waitFor(() => expect(sessionEffectRuns.count).toBe(1));
  }

  it('does not re-fire session effects when Supabase re-emits the same token', async () => {
    await renderSignedIn();

    // What INITIAL_SESSION does moments after init(), and what tab focus does after that:
    // a distinct object carrying the very same token.
    await act(async () => {
      emitAuthEvent('INITIAL_SESSION', makeSession('token-abc'));
    });
    await act(async () => {
      emitAuthEvent('SIGNED_IN', makeSession('token-abc'));
    });

    expect(sessionEffectRuns.count).toBe(1);
  });

  it('re-fires session effects on a genuine token refresh', async () => {
    await renderSignedIn();

    await act(async () => {
      emitAuthEvent('TOKEN_REFRESHED', makeSession('token-xyz'));
    });

    // A new token has to propagate — every panel's Authorization header depends on it.
    expect(sessionEffectRuns.count).toBe(2);
  });

  it('propagates a sign-out', async () => {
    await renderSignedIn();
    expect(tokensSeen[tokensSeen.length - 1]).toBe('token-abc');

    await act(async () => {
      emitAuthEvent('SIGNED_OUT', null);
    });

    expect(tokensSeen[tokensSeen.length - 1]).toBeNull();
  });

  // The guard keys on the access token, which is right for the session and wrong for the
  // user: Supabase fires USER_UPDATED with fresh metadata on the *same* token, and that is
  // exactly what updatePassword() produces. Guarding setUser on the token left hasPassword
  // stale, so PasswordSection kept offering "Set password" to someone who had just set one.
  it('propagates updated user metadata that arrives on the same token', async () => {
    await renderSignedIn();
    expect(hasPasswordSeen[hasPasswordSeen.length - 1]).toBe(false);

    await act(async () => {
      emitAuthEvent('USER_UPDATED', makeSession('token-abc', { has_password: true }));
    });

    expect(hasPasswordSeen[hasPasswordSeen.length - 1]).toBe(true);
    // ...and it still must not re-fire the fetches that caused the original bug.
    expect(sessionEffectRuns.count).toBe(1);
  });
});
