// @vitest-environment jsdom
// services/passkeys.ts against a stubbed Supabase client. What matters: a
// dismissed prompt is quiet, the autofill prompt never shows or reports an
// error before anyone picked a passkey, the person's own situations read as
// plain words without paging Sentry, and real faults do reach Sentry.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  signInWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      signInWithPasskey: mocks.signInWithPasskey,
      registerPasskey: mocks.registerPasskey,
      passkey: { list: mocks.list, delete: mocks.remove },
    },
  }),
}));
vi.mock('@sentry/react', () => ({ captureMessage: mocks.captureMessage }));

import { signInWithPasskey, registerPasskey, listPasskeys } from 'src/services/passkeys';

function failure(name: string, message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  error.name = name;
  error.code = code;
  return { data: null, error };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('signInWithPasskey', () => {
  it('signs in', async () => {
    mocks.signInWithPasskey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    expect(await signInWithPasskey()).toEqual({ status: 'signed-in' });
  });

  it('asks the browser for its autofill prompt only when told to', async () => {
    mocks.signInWithPasskey.mockResolvedValue({ data: {}, error: null });
    await signInWithPasskey();
    await signInWithPasskey({ autofill: true });
    expect(mocks.signInWithPasskey.mock.calls[0][0].options.mediation).toBeUndefined();
    expect(mocks.signInWithPasskey.mock.calls[1][0].options.mediation).toBe('conditional');
  });

  it('treats a dismissed prompt as cancelled, quietly', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('NotAllowedError', 'not allowed'));
    expect(await signInWithPasskey()).toEqual({ status: 'cancelled' });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('treats a prompt the page aborted as cancelled', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('WebAuthnError', 'aborted', 'ERROR_CEREMONY_ABORTED'));
    expect(await signInWithPasskey({ autofill: true })).toEqual({ status: 'cancelled' });
  });

  it('reports an expired challenge so the caller can start a fresh one', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('AuthApiError', 'expired', 'webauthn_challenge_expired'));
    expect(await signInWithPasskey({ autofill: true })).toEqual({ status: 'expired' });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('explains a passkey Unstream no longer knows, without paging Sentry', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('AuthApiError', 'not found', 'webauthn_credential_not_found'));
    const result = await signInWithPasskey();
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/isn't registered with Unstream/);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('keeps the autofill prompt silent when it fails before anyone picked a passkey', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('AuthRetryableFetchError', 'Failed to fetch'));
    expect(await signInWithPasskey({ autofill: true })).toEqual({ status: 'cancelled' });
    // Silent on the page, but a real fault: still reported.
    expect(mocks.captureMessage).toHaveBeenCalledOnce();
  });

  it('does not report a switched-off feature from the autofill prompt', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('AuthApiError', 'disabled', 'passkey_disabled'));
    expect(await signInWithPasskey({ autofill: true })).toEqual({ status: 'cancelled' });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('does report a switched-off feature when someone pressed the button', async () => {
    mocks.signInWithPasskey.mockResolvedValue(failure('AuthApiError', 'disabled', 'passkey_disabled'));
    const result = await signInWithPasskey();
    expect(result.status === 'failed' && result.error).toMatch(/isn't available right now/);
    expect(mocks.captureMessage).toHaveBeenCalledOnce();
  });
});

describe('registerPasskey', () => {
  it('returns no error for a dismissed prompt', async () => {
    mocks.registerPasskey.mockResolvedValue(failure('NotAllowedError', 'not allowed'));
    expect(await registerPasskey()).toEqual({ error: null });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('says so when this passkey is already on the account', async () => {
    mocks.registerPasskey.mockResolvedValue(failure('AuthApiError', 'exists', 'webauthn_credential_exists'));
    expect(await registerPasskey()).toEqual({ error: 'This passkey is already on your account.' });
  });

  it('reports a real failure', async () => {
    mocks.registerPasskey.mockResolvedValue(failure('SecurityError', 'The relying party ID is not a registrable domain suffix.'));
    const { error } = await registerPasskey();
    expect(error).toMatch(/relying party/);
    expect(mocks.captureMessage).toHaveBeenCalledOnce();
  });
});

describe('listPasskeys', () => {
  it('maps what Supabase returns to what Settings shows', async () => {
    mocks.list.mockResolvedValue({
      data: [{ id: 'p1', friendly_name: 'iCloud Keychain', created_at: '2026-11-01T00:00:00Z' }],
      error: null,
    });
    expect(await listPasskeys()).toEqual({
      passkeys: [{ id: 'p1', friendlyName: 'iCloud Keychain', createdAt: '2026-11-01T00:00:00Z', lastUsedAt: null }],
      error: null,
    });
  });
});
