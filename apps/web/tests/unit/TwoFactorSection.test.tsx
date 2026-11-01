// @vitest-environment jsdom
// The enrollment half of two-step verification, on /settings. What matters:
// the status line tells the truth about the account, an abandoned TOTP
// enrollment doesn't leave a stray factor behind, removal needs two clicks,
// and a passkey that the browser can't run is never offered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TwoFactorSection } from 'src/components/TwoFactorSection';

const mocks = vi.hoisted(() => ({
  listMfaFactors: vi.fn(),
  enrollTotp: vi.fn(),
  verifyTotp: vi.fn(),
  enrollPasskey: vi.fn(),
  unenrollFactor: vi.fn(),
  passkeysSupported: vi.fn(() => true),
}));

vi.mock('src/services/mfa', () => ({
  listMfaFactors: mocks.listMfaFactors,
  enrollTotp: mocks.enrollTotp,
  verifyTotp: mocks.verifyTotp,
  enrollPasskey: mocks.enrollPasskey,
  unenrollFactor: mocks.unenrollFactor,
  passkeysSupported: mocks.passkeysSupported,
}));

function factor(id: string, type: 'totp' | 'webauthn', status: 'verified' | 'unverified' = 'verified') {
  return {
    id,
    type,
    friendlyName: null,
    status,
    createdAt: '2026-10-15T12:00:00Z',
  };
}

const EMPTY = { factors: [], error: null };
const ENROLLMENT = {
  factorId: 'f-new',
  qrCode: 'data:image/svg+xml;utf8,test',
  secret: 'SECRET123',
};

describe('TwoFactorSection', () => {
  beforeEach(() => {
    mocks.listMfaFactors.mockReset().mockResolvedValue(EMPTY);
    mocks.enrollTotp.mockReset().mockResolvedValue({ enrollment: ENROLLMENT, error: null });
    mocks.verifyTotp.mockReset().mockResolvedValue({ error: null });
    mocks.enrollPasskey.mockReset().mockResolvedValue({ error: null });
    mocks.unenrollFactor.mockReset().mockResolvedValue({ error: null });
    mocks.passkeysSupported.mockReset().mockReturnValue(true);
  });

  afterEach(cleanup);

  it('says verification is off for an account with no factors', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText(/Add a second step to sign-in/)).toBeTruthy();
    });
    expect(screen.getByText('Add authenticator app')).toBeTruthy();
    expect(screen.getByText('Add passkey')).toBeTruthy();
  });

  it('says verification is on and lists the factors the account has', async () => {
    mocks.listMfaFactors.mockResolvedValue({
      factors: [factor('f-totp', 'totp'), factor('f-key', 'webauthn')],
      error: null,
    });

    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('On. Your account asks for a second step at sign-in.')).toBeTruthy();
    });
    expect(screen.getByText('Authenticator app')).toBeTruthy();
    expect(screen.getByText('Passkey')).toBeTruthy();
  });

  it('lists only verified factors — an abandoned enrollment is not a second step', async () => {
    mocks.listMfaFactors.mockResolvedValue({
      factors: [factor('f-old', 'totp', 'unverified')],
      error: null,
    });

    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText(/Add a second step to sign-in/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows the QR code and secret to enroll an authenticator app', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add authenticator app'));
    await waitFor(() => {
      expect(screen.getByAltText('QR code for your authenticator app')).toBeTruthy();
    });
    expect(screen.getByText('SECRET123')).toBeTruthy();
    expect(mocks.enrollTotp).toHaveBeenCalledTimes(1);
  });

  it('completes enrollment when the code matches, with the success notice', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add authenticator app'));
    await waitFor(() => {
      expect(screen.getByLabelText('Code from the app')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify and turn on'));

    await waitFor(() => {
      expect(mocks.verifyTotp).toHaveBeenCalledWith('f-new', '123456');
    });
    await waitFor(() => {
      expect(screen.getByText('Two-step verification is on. You will be asked for a code at sign-in.')).toBeTruthy();
    });
  });

  it('refuses a code that is not six digits without calling Supabase', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add authenticator app'));
    await waitFor(() => {
      expect(screen.getByLabelText('Code from the app')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Verify and turn on'));

    await waitFor(() => {
      expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeTruthy();
    });
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
  });

  it('explains a wrong enrollment code in human words', async () => {
    mocks.verifyTotp.mockResolvedValue({ error: 'Invalid TOTP code.' });

    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add authenticator app'));
    await waitFor(() => {
      expect(screen.getByLabelText('Code from the app')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify and turn on'));

    await waitFor(() => {
      expect(screen.getByText("That code didn't match. Codes change every 30 seconds — try the current one.")).toBeTruthy();
    });
  });

  it('unenrolls the pending factor when an enrollment is cancelled', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add authenticator app'));
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(mocks.unenrollFactor).toHaveBeenCalledWith('f-new');
    });
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });
  });

  it('enrolls a passkey from one click', async () => {
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add passkey')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add passkey'));
    await waitFor(() => {
      expect(mocks.enrollPasskey).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('Two-step verification is on. You will be asked for your passkey at sign-in.')).toBeTruthy();
    });
  });

  it('shows the passkey error from Supabase when enrollment fails', async () => {
    mocks.enrollPasskey.mockResolvedValue({ error: 'Unsupported factor type' });

    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add passkey')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Add passkey'));
    await waitFor(() => {
      expect(screen.getByText('Unsupported factor type')).toBeTruthy();
    });
  });

  it('never offers a passkey where the browser cannot run a ceremony', async () => {
    mocks.passkeysSupported.mockReturnValue(false);
    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Add authenticator app')).toBeTruthy();
    });
    expect(screen.queryByText('Add passkey')).toBeNull();
  });

  it('needs a second click to remove a factor', async () => {
    mocks.listMfaFactors.mockResolvedValue({
      factors: [factor('f-totp', 'totp')],
      error: null,
    });

    render(<TwoFactorSection />);
    await waitFor(() => {
      expect(screen.getByText('Remove')).toBeTruthy();
    });

    // First click only asks; nothing is deleted yet.
    fireEvent.click(screen.getByText('Remove'));
    expect(mocks.unenrollFactor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Yes, remove'));
    await waitFor(() => {
      expect(mocks.unenrollFactor).toHaveBeenCalledWith('f-totp');
    });
  });
});
