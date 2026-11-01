// @vitest-environment jsdom
// services/mfa.ts against a stubbed Supabase client: factor names stay unique
// (Supabase refuses a duplicate, which blocked every second authenticator
// app), and abandoned enrollments are cleared first.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      mfa: {
        listFactors: mocks.listFactors,
        unenroll: mocks.unenroll,
        enroll: mocks.enroll,
      },
    },
  }),
}));
vi.mock('@sentry/react', () => ({ captureMessage: mocks.captureMessage }));

import { enrollTotp } from 'src/services/mfa';

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
