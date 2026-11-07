// /api/analytics/promote: the Promote usage counts on /admin/analytics. Pins what each count
// asks the database (autopost switched on; campaigns not cancelled with a post today or later,
// since a finished campaign stays `active`), how the rows become counts, and that a failed read
// is an error rather than a confident zero.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  calls: [] as { table: string; method: string; args: unknown[] }[],
  admin: true,
}));

// A chainable stand-in for the Supabase query builder: records every call, and resolves to the
// result set for its table when awaited.
function query(table: string) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'range']) {
    builder[method] = (...args: unknown[]) => {
      mocks.calls.push({ table, method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown) => resolve(mocks.results[table]);
  return builder;
}

vi.mock('../db', async importOriginal => ({
  ...(await importOriginal<typeof import('../db')>()),
  getClient: () => ({ from: query }),
}));
vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: async () => (mocks.admin ? { userId: 'u1', email: 'admin@example.com' } : null),
}));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

import { handler } from '../analytics-promote';

function get() {
  return handler({ httpMethod: 'GET', headers: { authorization: 'Bearer t' } });
}

function callsTo(table: string, method: string) {
  return mocks.calls.filter(c => c.table === table && c.method === method).map(c => c.args);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T15:00:00Z'));
  mocks.calls = [];
  mocks.admin = true;
  mocks.results = {
    release_autopost_settings: {
      data: [
        { artist_id: 'a1', paused_reason: null },
        { artist_id: 'a2', paused_reason: 'buffer_disconnected' },
        { artist_id: 'a3', paused_reason: null },
      ],
      error: null,
    },
    release_campaigns: {
      data: [
        { id: 'c1', artist_id: 'a1', release_campaign_posts: [{ post_date: '2026-11-08' }] },
        { id: 'c2', artist_id: 'a1', release_campaign_posts: [{ post_date: '2026-11-07' }] },
        { id: 'c3', artist_id: 'a4', release_campaign_posts: [{ post_date: '2026-12-01' }] },
      ],
      error: null,
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('analytics-promote', () => {
  it('counts autopost artists, paused ones, running campaigns and the artists behind them', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      autopost: { enabled: 3, paused: 1 },
      campaigns: { running: 3, artists: 2 },
    });
  });

  it('counts only autopost switched on', async () => {
    await get();
    expect(callsTo('release_autopost_settings', 'eq')).toEqual([['enabled', true]]);
  });

  it('counts a campaign only while it is active and has a post today or later', async () => {
    await get();
    expect(callsTo('release_campaigns', 'select')[0][0]).toContain('release_campaign_posts!inner');
    expect(callsTo('release_campaigns', 'eq')).toEqual([['status', 'active']]);
    expect(callsTo('release_campaigns', 'gte')).toEqual([['release_campaign_posts.post_date', '2026-11-07']]);
  });

  it('answers 500, not zeros, when a read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.results.release_campaigns = { data: null, error: { message: 'boom' } };
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('running');
  });

  it('refuses anyone but the admin', async () => {
    mocks.admin = false;
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(mocks.calls).toEqual([]);
  });
});
