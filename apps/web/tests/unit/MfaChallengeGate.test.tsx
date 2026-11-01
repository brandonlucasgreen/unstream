// @vitest-environment jsdom
// The screen the app is held behind until a two-step session finishes its
// second factor. What matters: the right prompt appears for the factors the
// account has, a wrong code is explained in human words, a cancelled passkey
// prompt lets you try again, and the escape hatch signs you out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Session, Factor, User } from '@supabase/supabase-js';
import { MfaChallengeGate } from 'src/components/MfaChallengeGate';

const mocks = vi.hoisted(() => ({
  verifyTotp: vi.fn(),
  verifyWithPasskey: vi.fn(),
  passkeysSupported: vi.fn(() => true),
}));

vi.mock('src/services/mfa', () => ({
  verifyTotp: mocks.verifyTotp,
  verifyWithPasskey: mocks.verifyWithPasskey,
  passkeysSupported: mocks.passkeysSupported,
}));

function encode(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeFactor(id: string, type: 'totp' | 'webauthn', createdAt: string): Factor {
  return {
    id,
    factor_type: type,
    status: 'verified',
    created_at: createdAt,
    updated_at: createdAt,
  } as Factor;
}

function makeSession(factors: Factor[]): Session {
  const user = {
    id: 'user-1',
    email: 'fan@example.com',
    factors,
  } as unknown as User;
  return {
    access_token: `header.${encode({ aal: 'aal1' })}.sig`,
    user,
  } as unknown as Session;
}

function renderGate(factors: Factor[], onSignOut = vi.fn()) {
  return render(<MfaChallengeGate session={makeSession(factors)} onSignOut={onSignOut} />);
}

describe('MfaChallengeGate', () => {
  beforeEach(() => {
    mocks.verifyTotp.mockReset().mockResolvedValue({ error: null });
    mocks.verifyWithPasskey.mockReset().mockResolvedValue({ error: null, cancelled: false });
    mocks.passkeysSupported.mockReset().mockReturnValue(true);
  });

  afterEach(cleanup);

  it('asks for an authenticator-app code when the account has a TOTP factor', () => {
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')]);

    expect(screen.getByLabelText('Code from your authenticator app')).toBeTruthy();
    expect(screen.queryByText('Use your passkey')).toBeNull();
  });

  it('offers the passkey when the account has a webauthn factor and the browser supports it', () => {
    renderGate([makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z')]);

    expect(screen.getByText('Use your passkey')).toBeTruthy();
    expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
  });

  it('offers both when the account has one of each', () => {
    renderGate([
      makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z'),
      makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z'),
    ]);

    expect(screen.getByText('Use your passkey')).toBeTruthy();
    expect(screen.getByLabelText('Code from your authenticator app')).toBeTruthy();
  });

  it('hides the passkey option when the browser cannot run a ceremony', () => {
    mocks.passkeysSupported.mockReturnValue(false);
    renderGate([makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z')]);

    // Nothing to verify with — the gate stays honest rather than offering a
    // dead button, and the sign-out and recovery paths remain.
    expect(screen.queryByText('Use your passkey')).toBeNull();
    expect(screen.getByText('Two-step verification')).toBeTruthy();
    expect(screen.getByText('Sign out instead')).toBeTruthy();
    // ...and says why there's nothing to press, and where to go instead.
    expect(screen.getByText(/this browser can't use passkeys/)).toBeTruthy();
  });

  it('offers every passkey, each challenging its own factor', async () => {
    renderGate([
      makeFactor('f-mac', 'webauthn', '2026-10-01T00:00:00Z'),
      makeFactor('f-phone', 'webauthn', '2026-10-20T00:00:00Z'),
    ]);

    const buttons = screen.getAllByText(/^Use the passkey added/);
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => {
      expect(mocks.verifyWithPasskey).toHaveBeenCalledWith('f-phone');
    });
  });

  it('accepts a code pasted with the space authenticator apps show', async () => {
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')]);
    const input = screen.getByLabelText('Code from your authenticator app') as HTMLInputElement;

    // jsdom doesn't enforce maxLength on change events, so pin the attribute too:
    // at 6 a browser cut "123 456" to "123 45".
    expect(input.maxLength).toBeGreaterThanOrEqual(7);
    fireEvent.change(input, { target: { value: '123 456' } });
    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => {
      expect(mocks.verifyTotp).toHaveBeenCalledWith('f-totp', '123456');
    });
  });

  it('rejects a code that is not six digits without calling Supabase', async () => {
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')]);

    fireEvent.change(screen.getByLabelText('Code from your authenticator app'), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => {
      expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeTruthy();
    });
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
  });

  it('verifies against the most recently enrolled TOTP factor', async () => {
    renderGate([
      makeFactor('f-old', 'totp', '2026-06-01T00:00:00Z'),
      makeFactor('f-new', 'totp', '2026-10-01T00:00:00Z'),
    ]);

    fireEvent.change(screen.getByLabelText('Code from your authenticator app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => {
      expect(mocks.verifyTotp).toHaveBeenCalledWith('f-new', '123456');
    });
  });

  it('explains a wrong code in human words', async () => {
    mocks.verifyTotp.mockResolvedValue({ error: 'Invalid TOTP code.' });
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')]);

    fireEvent.change(screen.getByLabelText('Code from your authenticator app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => {
      expect(screen.getByText("That code didn't match. Codes change every 30 seconds — try the current one.")).toBeTruthy();
    });
  });

  it('shows the passkey error and lets the person try again', async () => {
    mocks.verifyWithPasskey.mockResolvedValue({ error: 'The request timed out.', cancelled: false });
    renderGate([makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z')]);

    fireEvent.click(screen.getByText('Use your passkey'));
    await waitFor(() => {
      expect(screen.getByText('The request timed out.')).toBeTruthy();
    });
    expect(screen.getByText('Use your passkey').closest('button')?.disabled).toBeFalsy();
  });

  it('re-enables the passkey button when the prompt was dismissed, without an error', async () => {
    mocks.verifyWithPasskey.mockResolvedValue({ error: null, cancelled: true });
    renderGate([makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z')]);

    fireEvent.click(screen.getByText('Use your passkey'));
    await waitFor(() => {
      expect(screen.getByText('Use your passkey').closest('button')?.disabled).toBeFalsy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signs out through the escape hatch', () => {
    const onSignOut = vi.fn();
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')], onSignOut);

    fireEvent.click(screen.getByText('Sign out instead'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
