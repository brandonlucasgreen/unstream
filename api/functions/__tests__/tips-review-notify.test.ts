// tips-review-notify: three things are being protected here.
//
//  1. The alert must fire exactly once per artist: a 30-minute cron that re-alarms the whole
//     pending list every run trains him to ignore the notification. The Upstash watermark of
//     account ids seen last run is the mechanism — these tests drive the fake directly.
//  2. It must not alert-spam when its own state is missing: with no Redis (no watermark) the run
//     refuses to classify anything and fails loudly instead of "new artist"ing the whole list.
//  3. A push failure must not swallow the account: the watermark only commits accounts actually
//     pushed, so a failed push retries next run.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: {
    from: vi.fn(),
  },
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getRedis: vi.fn(),
  fetchMock: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => mocks.client }));
vi.mock('../cache', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));
vi.mock('../redis', () => ({ getRedis: mocks.getRedis, reportRedisFailure: vi.fn() }));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: mocks.captureMessage, captureException: vi.fn() },
  initSentry: vi.fn(),
  isSentryInitialized: () => false,
}));

const { handler } = await import('../tips-review-notify');

const SECRET = 'tips-notify-test-secret';
const originalEnv = { ...process.env };

function rows(...entries: { id: string; name: string; slug: string; createdAt: string }[]) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({
        data: entries.map(e => ({
          stripe_account_id: e.id,
          created_at: e.createdAt,
          country: 'US',
          artists: { name: e.name, slug: e.slug },
        })),
        error: null,
      }),
  };
  return builder;
}

function secretHeaders() {
  return { authorization: `Bearer ${SECRET}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, INTERNAL_FUNCTION_SECRET: SECRET, PUSHOVER_APP_TOKEN: 'app-token', PUSHOVER_USER_KEY: 'user-key' };
  mocks.getRedis.mockReturnValue({ ready: true });
  mocks.cacheGet.mockResolvedValue([]);
  mocks.cacheSet.mockResolvedValue(true);
  vi.stubGlobal('fetch', mocks.fetchMock);
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe('tips-review-notify', () => {
  it('refuses unsigned requests', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(401);
  });

  it('alerts an artist new to the review list, once', async () => {
    mocks.client.from.mockReturnValue(rows({ id: 'acct_new', name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', createdAt: '2026-10-18T01:00:00Z' }));
    mocks.cacheGet.mockResolvedValue(['acct_old']); // watermark: old pending account seen last run
    mocks.fetchMock.mockResolvedValue(new Response('OK', { status: 200 }));

    const res = await handler({ httpMethod: 'GET', headers: secretHeaders() });
    const body = JSON.parse(res.body as string);
    expect(body).toEqual({ ok: true, fresh: 1, alerted: 1, awaiting: 1 });
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.pushover.net/1/messages.json');
    const sent = JSON.parse(init.body as string);
    expect(sent.title).toBe('New tip review: Kid Lightbulbs');
    expect(sent.url).toContain('/admin/tips');
    // The alerted account joins the watermark; the old one stays.
    const committed = mocks.cacheSet.mock.calls[0][1] as string[];
    expect(committed).toEqual(expect.arrayContaining(['acct_old', 'acct_new']));
    expect(committed).toHaveLength(2);
  });

  it('does not re-alert artists the last run already pushed', async () => {
    mocks.client.from.mockReturnValue(
      rows(
        { id: 'acct_a', name: 'A', slug: 'a', createdAt: '2026-10-18T01:00:00Z' },
        { id: 'acct_b', name: 'B', slug: 'b', createdAt: '2026-10-18T00:30:00Z' },
      ),
    );
    mocks.cacheGet.mockResolvedValue(['acct_a', 'acct_b']);
    const res = await handler({ httpMethod: 'GET', headers: secretHeaders() });
    const body = JSON.parse(res.body as string);
    expect(body).toMatchObject({ ok: true, fresh: 0, awaiting: 2 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.cacheSet).toHaveBeenCalled(); // TTL refresh
  });

  it('refuses to classify when the watermark store is down, rather than re-alarm everything', async () => {
    mocks.client.from.mockReturnValue(rows({ id: 'acct_x', name: 'X', slug: 'x', createdAt: '2026-10-18T01:00:00Z' }));
    mocks.getRedis.mockReturnValue(null);
    const res = await handler({ httpMethod: 'GET', headers: secretHeaders() });
    expect(res.statusCode).toBe(503);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('retries a still-unknown account when the push fails', async () => {
    mocks.client.from.mockReturnValue(rows({ id: 'acct_f', name: 'F', slug: 'f', createdAt: '2026-10-18T01:00:00Z' }));
    mocks.cacheGet.mockResolvedValue([]);
    mocks.fetchMock.mockResolvedValue(new Response('err', { status: 500 }));

    const res = await handler({ httpMethod: 'GET', headers: secretHeaders() });
    const body = JSON.parse(res.body as string);
    expect(body).toEqual({ ok: true, fresh: 1, alerted: 0, awaiting: 1 });
    // The failed account is NOT committed — next run sees it as fresh again.
    expect(mocks.cacheSet.mock.calls[0][1]).toEqual([]);
    expect(mocks.captureMessage).toHaveBeenCalled();
  });
});