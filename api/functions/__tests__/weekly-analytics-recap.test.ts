import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SECRET = 'test-internal-secret';
const originalEnv = { ...process.env };

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  sendNotificationOnce: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: mocks.getClient }));
vi.mock('../notifications', () => ({ sendNotificationOnce: mocks.sendNotificationOnce }));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
}));

import { handler } from '../weekly-analytics-recap';

function post(headers: Record<string, string | undefined> = { authorization: `Bearer ${SECRET}` }) {
  return handler({ httpMethod: 'POST', headers });
}

/** artist_profiles select().not() resolves directly; artist_analytics select().eq().gte() does too. */
function makeClient(opts: {
  profiles: { data: unknown; error?: unknown };
  analyticsByArtist?: Record<string, { metric: string; count: number }[]>;
}) {
  const from = vi.fn((table: string) => {
    if (table === 'artist_profiles') {
      return { select: () => ({ not: () => Promise.resolve(opts.profiles) }) };
    }
    if (table === 'artist_analytics') {
      return {
        select: () => ({
          eq: (_col: string, artistId: string) => ({
            gte: () => Promise.resolve({ data: opts.analyticsByArtist?.[artistId] || [], error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { from };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_FUNCTION_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('weekly-analytics-recap auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const r = await post({});
    expect(r.statusCode).toBe(401);
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('rejects non-POST', async () => {
    const r = await handler({ httpMethod: 'GET', headers: { authorization: `Bearer ${SECRET}` } });
    expect(r.statusCode).toBe(405);
  });
});

describe('weekly-analytics-recap', () => {
  it('sends nothing when there are no verified profiles', async () => {
    mocks.getClient.mockReturnValue(makeClient({ profiles: { data: [], error: null } }));

    const r = await post();

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ sent: 0, skipped: 0 });
    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
  });

  it('sends a recap per verified profile with this week\'s totals', async () => {
    mocks.getClient.mockReturnValue(makeClient({
      profiles: {
        data: [
          { artist_id: 'a1', email: 'artist1@example.com', artists: { name: 'Artist One', slug: 'artist-one' } },
        ],
        error: null,
      },
      analyticsByArtist: {
        a1: [
          { metric: 'search', count: 10 },
          { metric: 'view', count: 4 },
          { metric: 'click:bandcamp', count: 2 },
          { metric: 'click:patreon', count: 1 },
        ],
      },
    }));

    const r = await post();

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ sent: 1, skipped: 0 });
    expect(mocks.sendNotificationOnce).toHaveBeenCalledTimes(1);
    const call = mocks.sendNotificationOnce.mock.calls[0][0];
    expect(call.recipientEmail).toBe('artist1@example.com');
    expect(call.notificationType).toBe('weekly_analytics_recap');
    expect(call.referenceId).toMatch(/^a1:\d{4}-\d{2}-\d{2}$/);
    expect(call.html).toContain('10 search appearances');
    expect(call.html).toContain('4 profile views');
    expect(call.html).toContain('3 link clicks');
  });

  it('skips a profile missing an artist slug rather than sending a broken link', async () => {
    mocks.getClient.mockReturnValue(makeClient({
      profiles: {
        data: [{ artist_id: 'a1', email: 'artist1@example.com', artists: null }],
        error: null,
      },
    }));

    const r = await post();

    expect(JSON.parse(r.body)).toEqual({ sent: 0, skipped: 1 });
    expect(mocks.sendNotificationOnce).not.toHaveBeenCalled();
  });

  it('reports an upstream failure instead of claiming success', async () => {
    mocks.getClient.mockReturnValue({
      from: () => ({ select: () => ({ not: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    });

    const r = await post();

    expect(r.statusCode).toBe(503);
    expect(mocks.captureMessage).toHaveBeenCalled();
  });
});
