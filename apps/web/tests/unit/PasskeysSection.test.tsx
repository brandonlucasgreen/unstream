// @vitest-environment jsdom
// The Passkeys section of /settings. What matters: it lists passkeys by the
// name Supabase gives them, says "added" only when one really was, removal
// needs two clicks, and a browser that can't make passkeys isn't offered one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PasskeysSection } from 'src/components/PasskeysSection';

const mocks = vi.hoisted(() => ({
  listPasskeys: vi.fn(),
  registerPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  passkeysSupported: vi.fn(() => true),
}));

vi.mock('src/services/passkeys', () => ({
  listPasskeys: mocks.listPasskeys,
  registerPasskey: mocks.registerPasskey,
  deletePasskey: mocks.deletePasskey,
  passkeysSupported: mocks.passkeysSupported,
}));

const KEYCHAIN = { id: 'p1', friendlyName: 'iCloud Keychain', createdAt: '2026-10-15T12:00:00Z', lastUsedAt: null };
const PHONE = { id: 'p2', friendlyName: null, createdAt: '2026-10-20T12:00:00Z', lastUsedAt: null };

describe('PasskeysSection', () => {
  beforeEach(() => {
    mocks.listPasskeys.mockReset().mockResolvedValue({ passkeys: [], error: null });
    mocks.registerPasskey.mockReset().mockResolvedValue({ error: null });
    mocks.deletePasskey.mockReset().mockResolvedValue({ error: null });
    mocks.passkeysSupported.mockReset().mockReturnValue(true);
  });

  afterEach(cleanup);

  it('lists passkeys by their stored name, with a fallback', async () => {
    mocks.listPasskeys.mockResolvedValue({ passkeys: [KEYCHAIN, PHONE], error: null });
    render(<PasskeysSection />);
    await waitFor(() => {
      expect(screen.getByText('iCloud Keychain')).toBeTruthy();
    });
    expect(screen.getByText('Passkey')).toBeTruthy();
  });

  it('says it was added once a new passkey shows up', async () => {
    mocks.listPasskeys
      .mockResolvedValueOnce({ passkeys: [], error: null })
      .mockResolvedValueOnce({ passkeys: [KEYCHAIN], error: null });
    render(<PasskeysSection />);
    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());

    fireEvent.click(screen.getByText('Add a passkey'));
    await waitFor(() => {
      expect(screen.getByText(/Passkey added/)).toBeTruthy();
    });
    expect(screen.getByText('iCloud Keychain')).toBeTruthy();
  });

  it('says nothing when the prompt was dismissed', async () => {
    render(<PasskeysSection />);
    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());

    fireEvent.click(screen.getByText('Add a passkey'));
    await waitFor(() => expect(mocks.listPasskeys).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Passkey added/)).toBeNull();
  });

  it('shows the error when adding fails', async () => {
    mocks.registerPasskey.mockResolvedValue({ error: 'This passkey is already on your account.' });
    render(<PasskeysSection />);
    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());

    fireEvent.click(screen.getByText('Add a passkey'));
    await waitFor(() => {
      expect(screen.getByText('This passkey is already on your account.')).toBeTruthy();
    });
  });

  it('needs a second click to remove a passkey', async () => {
    mocks.listPasskeys.mockResolvedValue({ passkeys: [KEYCHAIN], error: null });
    render(<PasskeysSection />);
    await waitFor(() => expect(screen.getByText('Remove')).toBeTruthy());

    fireEvent.click(screen.getByText('Remove'));
    expect(mocks.deletePasskey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Yes, remove'));
    await waitFor(() => expect(mocks.deletePasskey).toHaveBeenCalledWith('p1'));
  });

  it('offers no button where the browser cannot make passkeys', async () => {
    mocks.passkeysSupported.mockReturnValue(false);
    render(<PasskeysSection />);
    await waitFor(() => expect(screen.getByText(/This browser can't create passkeys/)).toBeTruthy());
    expect(screen.queryByText('Add a passkey')).toBeNull();
  });
});
