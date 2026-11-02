// @vitest-environment jsdom
// Passkey sign-in on /login. What matters: the button appears only where the
// browser can run passkeys, the autofill prompt starts by itself and is
// cancelled before the button's prompt (browsers run one at a time), and a
// failure is shown in words.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session: null, isLoading: false }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams('')],
}));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/components/LegalConsent', () => ({ LegalConsent: () => null }));
vi.mock('src/services/auth', () => ({
  signInWithPassword: vi.fn(),
  signInWithMagicLink: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  signInWithPasskey: vi.fn(),
  passkeysSupported: vi.fn(() => true),
  passkeyAutofillSupported: vi.fn(async () => false),
}));
vi.mock('src/services/passkeys', () => ({
  signInWithPasskey: mocks.signInWithPasskey,
  passkeysSupported: mocks.passkeysSupported,
  passkeyAutofillSupported: mocks.passkeyAutofillSupported,
}));

import { LoginPage } from 'src/pages/LoginPage';

describe('LoginPage passkey sign-in', () => {
  beforeEach(() => {
    mocks.signInWithPasskey.mockReset().mockResolvedValue({ status: 'signed-in' });
    mocks.passkeysSupported.mockReset().mockReturnValue(true);
    mocks.passkeyAutofillSupported.mockReset().mockResolvedValue(false);
  });

  afterEach(cleanup);

  it('offers the button where the browser supports passkeys', () => {
    render(<LoginPage />);
    expect(screen.getByText('Sign in with a passkey')).toBeTruthy();
  });

  it('hides it where the browser cannot', () => {
    mocks.passkeysSupported.mockReturnValue(false);
    render(<LoginPage />);
    expect(screen.queryByText('Sign in with a passkey')).toBeNull();
  });

  it('lets the email field offer passkeys', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email address').getAttribute('autocomplete')).toBe('username webauthn');
  });

  it('starts the autofill prompt by itself, and cancels it before the button runs', async () => {
    mocks.passkeyAutofillSupported.mockResolvedValue(true);
    // The autofill prompt stays pending, as it does in a browser.
    mocks.signInWithPasskey.mockImplementation(({ autofill }: { autofill?: boolean } = {}) =>
      autofill ? new Promise(() => {}) : Promise.resolve({ status: 'signed-in' }),
    );
    render(<LoginPage />);
    await waitFor(() => expect(mocks.signInWithPasskey).toHaveBeenCalledTimes(1));
    const autofillCall = mocks.signInWithPasskey.mock.calls[0][0];
    expect(autofillCall.autofill).toBe(true);
    expect(autofillCall.signal.aborted).toBe(false);

    fireEvent.click(screen.getByText('Sign in with a passkey'));
    await waitFor(() => expect(mocks.signInWithPasskey).toHaveBeenCalledTimes(2));
    expect(autofillCall.signal.aborted).toBe(true);
    expect(mocks.signInWithPasskey.mock.calls[1][0]).toBeUndefined();
  });

  it('shows a failure in words', async () => {
    mocks.signInWithPasskey.mockResolvedValue({ status: 'failed', error: "That passkey isn't registered with Unstream anymore." });
    render(<LoginPage />);
    fireEvent.click(screen.getByText('Sign in with a passkey'));
    await waitFor(() => {
      expect(screen.getByText("That passkey isn't registered with Unstream anymore.")).toBeTruthy();
    });
  });
});
