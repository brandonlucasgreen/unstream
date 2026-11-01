// @vitest-environment jsdom
// services/mfa.ts against a stubbed Supabase client: factor names stay unique
// (Supabase refuses a duplicate, which blocked every second authenticator app
// or passkey), a dismissed passkey prompt is quiet, and a real passkey failure
// reaches Sentry.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
  register: vi.fn(),
  authenticate: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      mfa: {
        listFactors: mocks.listFactors,
        unenroll: mocks.unenroll,
        enroll: mocks.enroll,
        webauthn: { register: mocks.register, authenticate: mocks.authenticate },
      },
    },
  }),
}));
vi.mock('@sentry/react', () => ({ captureMessage: mocks.captureMessage }));

import { enrollTotp, enrollPasskey, verifyWithPasskey } from 'src/services/mfa';

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listFactors.mockResolvedValue({ data: { all: [] }, error: null });
  mocks.unenroll.mockResolvedValue({ error: null });
  mocks.enroll.mockResolvedValue({
    data: { id: 'f-1', totp: { qr_code: '<svg/>', secret: 'SECRET' } },
    error: null,
  });
});

describe('enrollment names', () => {
  it('gives each authenticator app its own name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    await enrollTotp();
    vi.setSystemTime(new Date('2026-11-01T10:05:00Z'));
    await enrollTotp();
    vi.useRealTimers();

    const [first, second] = mocks.enroll.mock.calls.map(([params]) => params.friendlyName);
    expect(first).not.toBe(second);
  });

  it('clears abandoned unverified factors before enrolling, leaving verified ones', async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: 'old-1', status: 'unverified' }, { id: 'old-2', status: 'unverified' }, { id: 'keep', status: 'verified' }] },
      error: null,
    });
    await enrollTotp();
    expect(mocks.unenroll.mock.calls.map(([p]) => p.factorId).sort()).toEqual(['old-1', 'old-2']);
  });
});

describe('enrollPasskey', () => {
  it("registers with a unique name for this page's relying party", async () => {
    mocks.register.mockResolvedValue({ data: {}, error: null });
    expect(await enrollPasskey()).toEqual({ error: null });
    const [params] = mocks.register.mock.calls[0];
    expect(params.friendlyName).toMatch(/^Passkey /);
    expect(params.webauthn.rpId).toBe(window.location.hostname);
  });

  it('treats a dismissed prompt as nothing to report', async () => {
    mocks.register.mockResolvedValue({ data: null, error: namedError('NotAllowedError', 'The operation either timed out or was not allowed.') });
    expect(await enrollPasskey()).toEqual({ error: null });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('reports a real failure to Sentry and shows it', async () => {
    mocks.register.mockResolvedValue({ data: null, error: namedError('SecurityError', 'The relying party ID is not a registrable domain suffix.') });
    const { error } = await enrollPasskey();
    expect(error).toMatch(/relying party/);
    expect(mocks.captureMessage).toHaveBeenCalledOnce();
  });
});

describe('verifyWithPasskey', () => {
  it('challenges the factor it was given', async () => {
    mocks.authenticate.mockResolvedValue({ data: {}, error: null });
    expect(await verifyWithPasskey('f-phone')).toEqual({ error: null, cancelled: false });
    expect(mocks.authenticate.mock.calls[0][0].factorId).toBe('f-phone');
  });

  it('reports a dismissed prompt as cancelled, not an error', async () => {
    mocks.authenticate.mockResolvedValue({ data: null, error: namedError('NotAllowedError', 'not allowed') });
    expect(await verifyWithPasskey('f-1')).toEqual({ error: null, cancelled: true });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });
});
