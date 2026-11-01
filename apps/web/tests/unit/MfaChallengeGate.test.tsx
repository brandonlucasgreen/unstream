// @vitest-environment jsdom
// The screen the app is held behind until a two-step session finishes its
// second factor. What matters: the right prompt appears for the factors the
// account has, a wrong code is explained in human words, and the escape hatch signs
// you out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Session, Factor, User } from '@supabase/supabase-js';
import { MfaChallengeGate } from 'src/components/MfaChallengeGate';

const mocks = vi.hoisted(() => ({
  verifyTotp: vi.fn(),
}));

vi.mock('src/services/mfa', () => ({
  verifyTotp: mocks.verifyTotp,
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
  });

  afterEach(cleanup);

  it('asks for an authenticator-app code when the account has a TOTP factor', () => {
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')]);

    expect(screen.getByLabelText('Code from your authenticator app')).toBeTruthy();
  });

  it('says where to turn when the only factor is one it cannot ask for', () => {
    renderGate([makeFactor('f-key', 'webauthn', '2026-11-01T00:00:00Z')]);

    // No dead input: the sign-out and recovery paths remain, and it says why.
    expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
    expect(screen.getByText('Sign out instead')).toBeTruthy();
    expect(screen.getByText(/isn't one this page can ask for/)).toBeTruthy();
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

  it('signs out through the escape hatch', () => {
    const onSignOut = vi.fn();
    renderGate([makeFactor('f-totp', 'totp', '2026-11-01T00:00:00Z')], onSignOut);

    fireEvent.click(screen.getByText('Sign out instead'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
