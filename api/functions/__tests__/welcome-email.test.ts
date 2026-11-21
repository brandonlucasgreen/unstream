// welcome-email: four things are being protected here.
//
//  1. The window. Too early and the person hasn't finished signing up; no upper bound and the
//     first deploy mails every account that ever signed up.
//  2. An unconfirmed address is never mailed: it may be someone else's inbox.
//  3. It goes out from support@ with replies to support@, because the whole point is the reply,
//     and at most once per account: email_log is read first, and its unique key stays the guard.
//  4. It stays on Netlify's schedule. The function takes no secret because only the scheduler can
//     reach it, so losing the schedule would silently stop the email.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  emailLogRead: vi.fn(),
  emailLogFrom: vi.fn(),
  sendNotificationOnce: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// email_log is read as from('email_log').select().eq().in(); the chain resolves to emailLogRead().
vi.mock('../db', () => ({
  getClient: () => ({
    auth: { admin: { listUsers: mocks.listUsers } },
    from: (table: string) => {
      mocks.emailLogFrom(table);
      return { select: () => ({ eq: () => ({ in: mocks.emailLogRead }) }) };
    },
  }),
}));
vi.mock('../notifications', () => ({ sendNotificationOnce: mocks.sendNotificationOnce }));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
  initSentry: vi.fn(),
  isSentryInitialized: () => false,
}));

const { handler, isDueForWelcome } = await import('../welcome-email');

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

const minutesAgo = (minutes: number) => minutes / 60;

// What Netlify's scheduler sends: a POST with `{ next_run }` and no credentials.
function post() {
  return handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ next_run: '2026-11-21T12:05:00Z' }),
  } as never) as Promise<{ statusCode: number; body: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.sendNotificationOnce.mockResolvedValue(undefined);
  mocks.emailLogRead.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDueForWelcome', () => {
  it('is not due in the first 15 minutes', () => {
    expect(isDueForWelcome(user('a', minutesAgo(14)), NOW)).toBe(false);
  });

  it('is due from 15 minutes until a day', () => {
    expect(isDueForWelcome(user('a', minutesAgo(15)), NOW)).toBe(true);
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
  it('mails only the accounts in the window, once each, from support@', async () => {
    mocks.listUsers.mockResolvedValue({
      data: { users: [user('fresh', minutesAgo(5)), user('due', minutesAgo(20)), user('unconfirmed', 4, false), user('old', 48)] },
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

  it('skips accounts email_log already holds a welcome for, without trying the insert', async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [user('welcomed', 2), user('due', 2)] }, error: null });
    mocks.emailLogRead.mockResolvedValue({ data: [{ reference_id: 'welcomed' }], error: null });

    const res = await post();

    expect(JSON.parse(res.body)).toMatchObject({ due: 1 });
    expect(mocks.emailLogRead).toHaveBeenCalledWith('reference_id', ['welcomed', 'due']);
    expect(mocks.sendNotificationOnce).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotificationOnce.mock.calls[0][0]).toMatchObject({ referenceId: 'due' });
  });

  it('does not read email_log when nobody is in the window', async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [user('fresh', minutesAgo(5)), user('old', 48)] }, error: null });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(mocks.emailLogFrom).not.toHaveBeenCalled();
  });

  it('sends nothing and fails loudly when email_log cannot be read', async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [user('due', 2)] }, error: null });
    mocks.emailLogRead.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('keeps no addresses in its response, which lands in the function log', async () => {
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

describe('the schedule', () => {
  // The function takes no secret because Netlify's scheduler is the only thing that can reach it.
  // Without this entry it is never run, and nothing else would notice the email had stopped.
  it('is scheduled every 5 minutes in netlify.toml', () => {
    const toml = readFileSync(join(__dirname, '../../../netlify.toml'), 'utf8');
    expect(toml).toMatch(/\[functions\."welcome-email"\]\s*\n\s*schedule = "\*\/5 \* \* \* \*"/);
  });
});
