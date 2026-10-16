// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above imports, so mock values must be
// declared with vi.hoisted() to be available when the factory runs.
const mocks = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockResolveAccountRequest: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockGetClientIp: vi.fn(() => '127.0.0.1'),
    mockSendEmail: vi.fn(),
  };
});

vi.mock('../db', () => ({
  getClient: () => ({
    from: mocks.mockFrom,
  }),
}));
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.mockResolveAccountRequest,
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../../lib/resend', () => ({
  sendTransactionalEmail: mocks.mockSendEmail,
}));

import { handler, hashToken, pendingConfirmLink } from '../me-email';

describe('me-email handler', () => {
  const validEvent = {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify({ new_email: 'new@example.com' }),
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
    mocks.mockSendEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The handler talks to email_change_requests through a sequence of one-shot builders:
  // POST happy path = [upsert, sweep delete], email-failure path adds a rollback delete.
  function stubTableSequence(builders: unknown[]) {
    let call = 0;
    mocks.mockFrom.mockImplementation(() => {
      const builder = builders[call];
      call += 1;
      return builder;
    });
  }

  const upsertBuilder = () => ({
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
  const sweepBuilder = () => ({
    delete: vi.fn(() => ({ lt: vi.fn().mockResolvedValue({ data: null, error: null }) })),
  });
  const rollbackBuilder = () => ({
    delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })),
  });

  it('returns 401 when not authenticated', async () => {
    mocks.mockResolveAccountRequest.mockResolvedValue({ key: 'ip:127.0.0.1', user: null });
    const res = await handler({ ...validEvent, headers: {} });
    expect(res!.statusCode).toBe(401);
  });

  it('rejects an invalid email format', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ new_email: 'not-an-email' }) });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toContain("doesn't look right");
  });

  it('rejects the current address (case-insensitively)', async () => {
    const res = await handler({ ...validEvent, body: JSON.stringify({ new_email: 'OLD@example.com' }) });
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body).error).toBe('That is already your email address.');
  });

  it('stores a pending change and emails the confirmation link to the new address', async () => {
    const upsert = upsertBuilder();
    const sweep = sweepBuilder();
    stubTableSequence([upsert, sweep]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(202);
    const body = JSON.parse(res!.body);
    expect(body.pending).toBe(true);
    expect(body.new_email).toBe('new@example.com');

    // The upsert carries the hashed token and a 24h expiry, keyed on user_id.
    expect(upsert.upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.upsert.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(row.user_id).toBe('user-1');
    expect(row.new_email).toBe('new@example.com');
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex — never the plaintext token
    expect(row.expires_at).toBeTruthy();
    expect(opts).toEqual({ onConflict: 'user_id' });

    // The sweep targets expired rows only.
    const sweepLt = (sweep.delete as ReturnType<typeof vi.fn>).mock.results[0].value.lt;
    expect(sweepLt).toHaveBeenCalledWith('expires_at', expect.any(String));

    // The email goes to the NEW address with a /settings?confirm_email=<token> link.
    const sent = mocks.mockSendEmail.mock.calls[0][0] as { to: string; subject: string; html: string; text: string };
    expect(sent.to).toBe('new@example.com');
    expect(sent.subject).toContain('Confirm your new email');
    expect(sent.html).toMatch(/settings\?confirm_email=[0-9a-f]{64}/);
    expect(sent.text).toMatch(/settings\?confirm_email=[0-9a-f]{64}/);
    // The stored hash must match the token in the link.
    const linkToken = sent.html.match(/confirm_email=([0-9a-f]{64})/)?.[1];
    expect(hashToken(linkToken as string)).toBe(row.token_hash);
  });

  it('lowercases the requested address before storing it', async () => {
    const upsert = upsertBuilder();
    const sweep = sweepBuilder();
    stubTableSequence([upsert, sweep]);

    await handler({ ...validEvent, body: JSON.stringify({ new_email: 'New@Example.COM' }) });
    const [row] = upsert.upsert.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(row.new_email).toBe('new@example.com');
  });

  it('rolls back the pending row and returns 502 when the email send fails', async () => {
    mocks.mockSendEmail.mockResolvedValue({ ok: false, error: 'Resend rejected' });
    const upsert = upsertBuilder();
    const sweep = sweepBuilder();
    const rollback = rollbackBuilder();
    stubTableSequence([upsert, sweep, rollback]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(502);
    expect(JSON.parse(res!.body).error).toContain('could not be sent');
    expect(rollback.delete).toHaveBeenCalled();
  });

  it('returns 500 without sending when the upsert fails', async () => {
    const upsert = {
      upsert: vi.fn().mockResolvedValue({ data: null, error: { message: 'no such table' } }),
    };
    stubTableSequence([upsert]);

    const res = await handler(validEvent);
    expect(res!.statusCode).toBe(500);
    expect(mocks.mockSendEmail).not.toHaveBeenCalled();
  });

  it('DELETE cancels the pending change', async () => {
    const del = rollbackBuilder();
    stubTableSequence([del]);

    const res = await handler({ ...validEvent, httpMethod: 'DELETE', body: null });
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body).cancelled).toBe(true);
    const delEq = (del.delete as ReturnType<typeof vi.fn>).mock.results[0].value.eq;
    expect(delEq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns 404 for unknown methods', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'PUT' });
    expect(res!.statusCode).toBe(404);
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handler({ ...validEvent, httpMethod: 'OPTIONS' });
    expect(res!.statusCode).toBe(204);
  });

  it('uses the account rate-limit tier', async () => {
    const upsert = upsertBuilder();
    const sweep = sweepBuilder();
    stubTableSequence([upsert, sweep]);

    await handler(validEvent);
    expect(mocks.mockCheckRateLimit).toHaveBeenCalledWith('user:user-1', 'account', expect.any(Object));
  });
});

describe('me-email helpers', () => {
  it('pendingConfirmLink points at /settings with the token', () => {
    expect(pendingConfirmLink('abc123')).toBe('https://unstream.stream/settings?confirm_email=abc123');
  });

  it('hashToken is sha256 hex', () => {
    // sha256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

export {};