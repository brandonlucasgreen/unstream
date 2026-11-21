// welcome-email: three things are being protected here.
//
//  1. The window. Too early and it isn't "a few hours later"; no upper bound and the first deploy
//     mails every account that ever signed up.
//  2. An unconfirmed address is never mailed: it may be someone else's inbox.
//  3. It goes out from support@ with replies to support@, because the whole point is the reply,
//     and at most once per account (the email_log guard, keyed on the user id).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  sendNotificationOnce: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => ({ auth: { admin: { listUsers: mocks.listUsers } } }) }));
vi.mock('../notifications', () => ({ sendNotificationOnce: mocks.sendNotificationOnce }));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
  initSentry: vi.fn(),
  isSentryInitialized: () => false,
}));

const { handler, isDueForWelcome } = await import('../welcome-email');

const SECRET = 'welcome-test-secret';
const originalEnv = { ...process.env };
const NOW = new Date('2026-11-21T12:00:00Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function user(id: string, createdHoursAgo: number, confirmed = true) {
  return {
    id,
    email: `${id}@example.com`,
    created_at: hoursAgo(createdHoursAgo),
    email_confirmed_at: confirmed ? hoursAgo(createdHoursAgo) : undefined,
  };
}

function post(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return handler({ httpMethod: 'POST', headers } as never) as Promise<{ statusCode: number; body: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  process.env = { ...originalEnv, INTERNAL_FUNCTION_SECRET: SECRET };
  mocks.sendNotificationOnce.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  process.env = originalEnv;
});

describe('isDueForWelcome', () => {
  it('is not due in the first three hours', () => {
    expect(isDueForWelcome(user('a', 2.9), NOW)).toBe(false);
  });

  it('is due from three hours until a day', () => {
    expect(isDueForWelcome(user('a', 3), NOW)).toBe(true);
    expect(isDueForWelcome(user('a', 23.9), NOW)).toBe(true);
  });

  it('is never due for an account older than a day, so a deploy does not mail everyone', () => {
    expect(isDueForWelcome(user('a', 24), NOW)).toBe(false);
    expect(isDueForWelcome(user('a', 24 * 90), NOW)).toBe(false);
  });

  it('is never due for an unconfirmed address', () => {
    expect(isDueForWelcome(user('a', 5, false), NOW)).toBe(false);
  });
});

describe('welcome-email handler', () => {
  it('refuses unsigned requests', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(401);
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it('mails only the accounts in the window, once each, from support@', async () => {
    mocks.listUsers.mockResolvedValue({
      data: { users: [user('fresh', 1), user('due', 4), user('unconfirmed', 4, false), user('old', 48)] },
      error: null,
    });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, accounts: 4, due: 1 });
    expect(mocks.sendNotificationOnce).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotificationOnce.mock.calls[0][0]).toMatchObject({
      notificationType: 'welcome',
      referenceId: 'due',
      recipientEmail: 'due@example.com',
      from: 'Brandon from Unstream <support@unstream.stream>',
      replyTo: 'support@unstream.stream',
    });
  });

  it('keeps no addresses in its response, which lands in the Actions log', async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [user('due', 4)] }, error: null });

    const res = await post();

    expect(res.body).not.toContain('@');
  });

  it('reads every page of users', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => user(`old${i}`, 48));
    mocks.listUsers
      .mockResolvedValueOnce({ data: { users: fullPage }, error: null })
      .mockResolvedValueOnce({ data: { users: [user('due', 4)] }, error: null });

    const res = await post();

    expect(mocks.listUsers).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body)).toMatchObject({ accounts: 1001, due: 1 });
  });

  it('fails loudly when the user list fails, and sends nothing', async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [] }, error: { message: 'boom' } });

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
