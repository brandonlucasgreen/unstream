// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: null, isLoading: false }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/components/LegalConsent', () => ({ LegalConsent: () => null }));

const signInWithMagicLink = vi.fn();
const resetPasswordForEmail = vi.fn();
vi.mock('src/services/auth', () => ({
  signInWithPassword: vi.fn(),
  signInWithMagicLink: (...args: unknown[]) => signInWithMagicLink(...args),
  resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args),
}));

import { LoginPage } from 'src/pages/LoginPage';

const INVALID_MESSAGE = "That email address doesn't look right. Check it and try again.";

function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value } });
}

/**
 * Both of these buttons are `type="button"`, so the input's `type="email"` never
 * runs — a mistyped address used to reach Supabase and come back as a raw 400
 * (Sentry UNSTREAM-WEB-J, "Auth failed: resetPassword"). These pin the check that
 * stops it at the boundary.
 */
describe('LoginPage email validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithMagicLink.mockResolvedValue({ error: null });
    resetPasswordForEmail.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not call Supabase when Forgot password is clicked with a malformed email', async () => {
    render(<LoginPage />);
    typeEmail('artist@example');
    fireEvent.click(screen.getByText('Forgot password?'));

    await waitFor(() => {
      expect(screen.getByText(INVALID_MESSAGE)).not.toBeNull();
    });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('still asks for an email when Forgot password is clicked with the field empty', async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByText('Forgot password?'));

    await waitFor(() => {
      expect(screen.getByText('Enter your email address first.')).not.toBeNull();
    });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('sends the reset for a well-formed email', async () => {
    render(<LoginPage />);
    typeEmail('  artist@example.com  ');
    fireEvent.click(screen.getByText('Forgot password?'));

    await waitFor(() => {
      expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    });
    // Trimmed, and pointed at the reset page rather than /login.
    expect(resetPasswordForEmail.mock.calls[0][0]).toBe('artist@example.com');
    expect(resetPasswordForEmail.mock.calls[0][1]).toBe('http://localhost:3000/reset-password');
    expect(screen.getByText('Check your email')).not.toBeNull();
  });

  it('does not call Supabase when the magic link is requested with a malformed email', async () => {
    render(<LoginPage />);
    typeEmail('artist@');
    fireEvent.click(screen.getByText('Send sign-in link to email'));

    await waitFor(() => {
      expect(screen.getByText(INVALID_MESSAGE)).not.toBeNull();
    });
    expect(signInWithMagicLink).not.toHaveBeenCalled();
  });

  it('sends the magic link for a well-formed email', async () => {
    render(<LoginPage />);
    typeEmail('artist@example.com');
    fireEvent.click(screen.getByText('Send sign-in link to email'));

    await waitFor(() => {
      expect(signInWithMagicLink).toHaveBeenCalledTimes(1);
    });
    expect(signInWithMagicLink.mock.calls[0][0]).toBe('artist@example.com');
  });
});
