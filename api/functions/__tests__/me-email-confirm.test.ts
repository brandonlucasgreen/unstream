// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockAuthAdminUpdate: vi.fn(),
    mockResolveAccountRequest: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockGetClientIp: vi.fn(() => '127.0.0.1'),
  };
});

vi.mock('../db', () => ({
  getClient: () => ({
    from: mocks.mockFrom,
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        updateUserById: mocks.mockAuthAdminUpdate,
      },
    },
  })),
}));
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.mockResolveAccountRequest,
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../me-email-confirm';

// The handler's return type is a union over its branches, so header access needs a cast.
function headersOf(response: { headers: unknown } | null | undefined): Record<string, string> {
  return response!.headers as Record<string, string>;
}

// The token me-email would have emailed. The row stores sha256(token) as hex.
const TOKEN = 'a'.repeat(64);
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: 'user-1',
    new_email: 'new@example.com',
    token_hash: tokenHash(TOKEN),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('me-email-confirm handler', () => {
  const validEvent = {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify({ token: TOKEN }),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    mocks.mockResolveAccountRequest.mockResolvedValue({
      key: 'user:user-1',
      user: { userId: 'user-1', email: 'old@example.com' },
    });
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockAuthAdminUpdate.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Confirm flow reads the pending row (select → eq → maybeSingle), then deletes it after
  // applying. Each .from() call returns the next builder in the list.
  function stubTableSequence(builders: unknown[]) {
    let call = 0;
    mocks.mockFrom.mockImplementation(() => {
      const builder = builders[call];
      call += 1;
      return builder;
    });
  }

  const selectBuilder = (row: { data: unknown; error: unknown }) => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn().mockResolvedValue(row),
      })),
    })),
  });
  const deleteBuilder = () => ({
    delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })),
  });

  it('returns 401 when not authenticated', async () => {
    mocks.mockResolveAccountRequest.mockResolvedValue({ key: 'ip:127.0.0.1', user: null });
    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(401);
  });

  it('returns 400 for a malformed token instead of touching the database', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ token: 'short' }) });
    expect(res!.statusCode).toBe(400);
    expect(mocks.mockFrom).not.toHaveBeenCalled();
  });

  it('returns 404 with one message when there is no pending row', async () => {
    stubTableSequence([selectBuilder({ data: null, error: null })]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(404);
    // The delete is never reached when there is nothing to delete.
    expect(mocks.mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the pending-row lookup fails, leaving the row alone', async () => {
    stubTableSequence([
      { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }) }) }) },
    ]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
    expect(JSON.parse(res!.body).error).toContain('Could not look up');
  });

  it('returns 403 without deleting the row on a token mismatch', async () => {
    stubTableSequence([selectBuilder({ data: pendingRow({ token_hash: tokenHash('b'.repeat(64)) }), error: null })]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(403);
    expect(JSON.parse(res!.body).error).toContain('not valid');
    // Only the select happened; the pending row survives for the real link.
    expect(mocks.mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns 410 for an expired link and sweeps the row', async () => {
    const sel = selectBuilder({ data: pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() }), error: null });
    const del = deleteBuilder();
    stubTableSequence([sel, del]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(410);
    expect(del.delete).toHaveBeenCalled();
  });

  it('applies the change via the admin API and burns the token on success', async () => {
    const sel = selectBuilder({ data: pendingRow(), error: null });
    const del = deleteBuilder();
    stubTableSequence([sel, del]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body);
    expect(body.confirmed).toBe(true);
    expect(body.email).toBe('new@example.com');

    expect(mocks.mockAuthAdminUpdate).toHaveBeenCalledWith('user-1', {
      email: 'new@example.com',
      email_confirm: true,
    });
    expect(del.delete).toHaveBeenCalled();
  });

  it('maps a "registered" update error to 409 and cancels the pending change', async () => {
    const sel = selectBuilder({ data: pendingRow(), error: null });
    const del = deleteBuilder();
    stubTableSequence([sel, del]);
    mocks.mockAuthAdminUpdate.mockResolvedValue({
      data: null,
      error: { message: 'email address "new@example.com" already has been registered' },
    });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(409);
    expect(JSON.parse(res!.body).error).toContain('already on another Unstream account');
    expect(del.delete).toHaveBeenCalled();
  });

  // Item 9: the duplicate shapes Supabase actually emits still map to 409 + cleanup.
  it.each([
    'user already exists',
    'A user with this email address is already in use',
    'email address "new@example.com" already exists',
  ])('maps the duplicate shape %s to 409', async (message) => {
    const sel = selectBuilder({ data: pendingRow(), error: null });
    const del = deleteBuilder();
    stubTableSequence([sel, del]);
    mocks.mockAuthAdminUpdate.mockResolvedValue({ data: null, error: { message } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(409);
    expect(del.delete).toHaveBeenCalled();
  });

  // Item 9: a transient failure that merely mentions "exists" must NOT be read as a
  // duplicate — the old bare /\bexists\b/ catch-all cancelled the pending change for good.
  it.each(['relation "email_change_requests" does not exist', 'column exists but is not writable'])(
    'treats the non-duplicate error %s as a retryable 500',
    async (message) => {
      stubTableSequence([selectBuilder({ data: pendingRow(), error: null })]);
      mocks.mockAuthAdminUpdate.mockResolvedValue({ data: null, error: { message } });

      const res = await handler(validEvent);
      expect(res!.statusCode).toBe(500);
      // Row survives — the token is still good, the user can use the same link again.
      expect(mocks.mockFrom).toHaveBeenCalledTimes(1);
    },
  );

  it('maps other update errors to 500 and leaves the row for a retry', async () => {
    stubTableSequence([selectBuilder({ data: pendingRow(), error: null })]);
    mocks.mockAuthAdminUpdate.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
    // Row not deleted — the token is still good, the failure was transient.
    expect(mocks.mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns 405 with an Allow header for non-POST methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'GET', body: null });
    expect(res!.statusCode).toBe(405);
    expect(headersOf(res).Allow).toBe('POST, OPTIONS');
  });

  it('scopes Access-Control-Allow-Origin to the site allowlist, never a wildcard', async () => {
    stubTableSequence([selectBuilder({ data: null, error: null })]);

    const res = await handler({
      ...validEvent,
      headers: { ...validEvent.headers, origin: 'https://evil.example' },
    });
    expect(headersOf(res)['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
    expect(headersOf(res)['Access-Control-Allow-Origin']).not.toBe('*');
    expect(headersOf(res)['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('uses the strict rate-limit tier', async () => {
    stubTableSequence([selectBuilder({ data: null, error: null })]);

    await handler(validEvent);
    expect(mocks.mockCheckRateLimit).toHaveBeenCalledWith('user:user-1', 'strict', expect.any(Object));
  });
});

export {};