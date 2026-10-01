// @vitest-environment jsdom
//
// The save-artist prompt is where most fans sign up, and its magic link used to be sent with
// no `emailRedirectTo`. Supabase then falls back to the Site URL, so a brand-new account
// confirmed its email and landed on the home page with no sign it had signed up. The link has
// to come back through /login, which forwards a session to the dashboard and its welcome.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from 'src/contexts/AuthContext';

const mocks = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
      signInWithOtp: mocks.signInWithOtp,
      signInWithPassword: vi.fn(),
    },
  }),
  waitForMagicLinkSession: vi.fn(),
}));

describe('AuthContext magic link redirect', () => {
  afterEach(cleanup);

  it('sends the link back through /login rather than the Site URL', async () => {
    mocks.signInWithOtp.mockResolvedValue({ error: null });
    const captured: { signIn?: (email: string) => Promise<void> } = {};
    function Capture() {
      const { signInWithMagicLink } = useAuth();
      useEffect(() => {
        captured.signIn = signInWithMagicLink;
      }, [signInWithMagicLink]);
      return null;
    }

    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>
    );
    await waitFor(() => expect(captured.signIn).toBeDefined());
    await act(() => captured.signIn!('fan@example.com'));

    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: 'fan@example.com',
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
  });
});
