// /admin/analytics reported 641 of 10,380 searches in production on 2026-08-23. Every aggregate
// was a raw app_events read counted in a JS loop, and PostgREST silently truncated each one at
// 1,000 rows — `by_app` and `streaming_services` both totalled *exactly* 1000, which is the tell.
// The daily query ordered created_at ASC, so the 1,000 rows that survived were the oldest and the
// most recent 26 days rendered as zero.
//
// These tests pin the two properties that fix depends on: the counts come from the analytics_*
// SQL functions (so no row cap is in the path), and the per-group counts are *summed* rather than
// incremented by one per row. They also pin the date range and the client and search-kind splits
// added on 2026-10-27.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({ rpc: mocks.mockRpc }),
}));
// buildCorsHeaders is not stubbed to a constant: this endpoint used to hand back a wildcard
// origin from a hand-rolled const, and the point of routing it through the shared helper is that
// it no longer does. Mirrors the real helper's non-API-key behaviour (pin to the canonical
// origin) so that stays assertable.
vi.mock('../middleware', () => ({
  authenticateAdmin: async () => ({ userId: 'u1', email: 'admin@example.com' }),
  buildCorsHeaders: (origin: string | undefined, apiKeyPresent: boolean) => ({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': apiKeyPresent
      ? '*'
      : origin === 'https://unstream.stream'
        ? origin
        : 'https://unstream.stream',
  }),
}));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

import { handler } from '../analytics-dashboard';

const today = new Date().toISOString().split('T')[0];

type ContextArgs = { p_key: string };

// Deliberately far above 1,000 per group: any code path that counted rows one at a time under
// the PostgREST cap could not produce these totals.
const RPC_DATA: Record<string, unknown[]> = {
  analytics_search_success: [{ completed: 4000, with_results: 3000 }],
  analytics_daily_events: [
    { day: today, event_type: 'search', events: 7400 },
    { day: today, event_type: 'platform_click', events: 2100 },
    { day: today, event_type: 'extension_activated', events: 1500 },
  ],
  analytics_events_by_app: [
    { app: 'web', event_type: 'search', events: 5000 },
    { app: 'web', event_type: 'platform_click', events: 2100 },
    { app: 'extension', event_type: 'search', events: 2400 },
    { app: 'extension', event_type: 'platform_click', events: 300 },
  ],
};

const CONTEXT_DATA: Record<string, unknown[]> = {
  platform: [
    { event_type: 'platform_click', app: 'web', value: 'bandcamp', events: 1500 },
    { event_type: 'platform_click', app: 'extension', value: 'bandcamp', events: 300 },
    { event_type: 'platform_click', app: 'web', value: 'mirlo', events: 300 },
  ],
  streaming_service: [
    { event_type: 'extension_activated', app: 'extension', value: 'youtube', events: 1200 },
    { event_type: 'extension_activated', app: 'extension', value: 'spotify', events: 300 },
  ],
  // 2,400 extension searches: 1,000 from Chrome builds, 400 from Firefox, the other 1,000 from
  // versions that didn't send a browser.
  browser: [
    { event_type: 'search', app: 'extension', value: 'chrome', events: 1000 },
    { event_type: 'search', app: 'extension', value: 'firefox', events: 400 },
    { event_type: 'platform_click', app: 'extension', value: 'chrome', events: 300 },
  ],
  search_kind: [
    { event_type: 'search', app: 'web', value: 'typed', events: 4000 },
    { event_type: 'search', app: 'extension', value: 'now_playing', events: 1200 },
    { event_type: 'search', app: 'extension', value: 'typed', events: 200 },
  ],
};

function rpcResult(fn: string, args: ContextArgs) {
  const data = fn === 'analytics_context_counts' ? CONTEXT_DATA[args.p_key] : RPC_DATA[fn];
  return Promise.resolve({ data: data ?? [], error: null });
}

function get(headers: Record<string, string | undefined> = {}, query: Record<string, string> = {}) {
  return handler({
    httpMethod: 'GET',
    headers: { authorization: 'Bearer t', ...headers },
    queryStringParameters: query,
  });
}

async function body(query: Record<string, string> = {}) {
  const res = await get({}, query);
  return JSON.parse(res.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockRpc.mockImplementation(rpcResult);
});

describe('aggregation happens in Postgres', () => {
  it('asks the analytics_* functions for every breakdown', async () => {
    await get();
    expect(mocks.mockRpc.mock.calls.map(c => c[0]).sort()).toEqual([
      'analytics_context_counts',
      'analytics_context_counts',
      'analytics_context_counts',
      'analytics_context_counts',
      'analytics_daily_events',
      'analytics_events_by_app',
      'analytics_search_success',
    ]);
  });

  it('sums the grouped counts instead of counting rows', async () => {
    const d = await body();
    const bucket = d.chart.find((r: { date: string }) => r.date === today);
    // A regression to `bucket.searches++` would make these 1, 1 and 1.
    expect(bucket).toMatchObject({ searches: 7400, clicks: 2100, activations: 1500 });
    expect(d.clients.find((c: { app: string }) => c.app === 'web'))
      .toMatchObject({ searches: 5000, clicks: 2100 });
    // Platform totals are summed across apps.
    expect(d.platforms[0]).toEqual({ platform: 'bandcamp', clicks: 1800 });
    expect(d.streaming_services[0]).toEqual({ service: 'youtube', activations: 1200 });
  });

  it('reports the search total as the sum of the chart', async () => {
    // The total used to be a separate count of app_events, which sees only the last 90 days:
    // older events live in the rollup. Summing the chart makes the two agree by construction.
    const d = await body();
    expect(d.summary.searches).toBe(7400);
    expect(d.summary.searches_per_day).toBe(Math.round(7400 / 30));
  });

  it('derives the success rate from the function’s two totals', async () => {
    const d = await body();
    expect(d.summary.success_rate).toBe(75);
  });

  it('reports no success rate rather than a wrong one when nothing completed', async () => {
    mocks.mockRpc.mockImplementation((fn: string, args: ContextArgs) =>
      fn === 'analytics_search_success'
        ? Promise.resolve({ data: [{ completed: 0, with_results: 0 }], error: null })
        : rpcResult(fn, args)
    );
    const d = await body();
    expect(d.summary.success_rate).toBeNull();
  });
});

describe('clients', () => {
  it('splits the extension by browser, with older versions on their own row', async () => {
    const d = await body();
    const extension = d.clients.filter((c: { app: string }) => c.app === 'extension');
    expect(extension).toEqual([
      { app: 'extension', browser: 'chrome', searches: 1000, clicks: 300 },
      { app: 'extension', browser: 'firefox', searches: 400, clicks: 0 },
      { app: 'extension', browser: 'unrecorded', searches: 1000, clicks: 0 },
    ]);
  });

  it('leaves out the unrecorded row once every event carries a browser', async () => {
    mocks.mockRpc.mockImplementation((fn: string, args: ContextArgs) =>
      fn === 'analytics_events_by_app'
        ? Promise.resolve({
            data: [
              { app: 'extension', event_type: 'search', events: 1400 },
              { app: 'extension', event_type: 'platform_click', events: 300 },
            ],
            error: null,
          })
        : rpcResult(fn, args)
    );
    const d = await body();
    expect(d.clients.map((c: { browser: string | null }) => c.browser)).not.toContain('unrecorded');
  });

  it('splits searches into typed, now playing and unlabelled', async () => {
    const d = await body();
    expect(d.search_kinds).toEqual([
      { app: 'web', typed: 4000, now_playing: 0, unlabelled: 1000 },
      { app: 'extension', typed: 200, now_playing: 1200, unlabelled: 1000 },
      { app: 'mac', typed: 0, now_playing: 0, unlabelled: 0 },
    ]);
  });
});

describe('date range', () => {
  it('passes the range to every function as UTC midnights', async () => {
    await get({}, { from: '2026-09-01', to: '2026-09-30' });
    for (const [, args] of mocks.mockRpc.mock.calls) {
      expect(args).toMatchObject({
        p_since: '2026-09-01T00:00:00.000Z',
        p_until: '2026-10-01T00:00:00.000Z',
      });
    }
  });

  it('charts a long range by week', async () => {
    const d = await body({ from: '2026-05-04', to: '2026-10-04' });
    expect(d.range.granularity).toBe('week');
    // 2026-05-04 is a Monday; 2026-10-04 a Sunday — 22 whole weeks.
    expect(d.chart).toHaveLength(22);
    expect(d.chart[0].date).toBe('2026-05-04');
  });

  it('refuses a malformed range', async () => {
    const res = await get({}, { from: 'last tuesday' });
    expect(res.statusCode).toBe(400);
    expect(mocks.mockRpc).not.toHaveBeenCalled();
  });
});

describe('CORS', () => {
  it('never answers an admin request with a wildcard origin', async () => {
    // Was `'Access-Control-Allow-Origin': '*'` in a local const here, the one admin endpoint
    // not using the shared helper. Not exploitable on its own — a cross-origin page can't get
    // the bearer token — but it contradicted the model every sibling endpoint follows.
    for (const origin of [undefined, 'https://unstream.stream', 'https://evil.example']) {
      const res = await get({ origin });
      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
    }
  });

  it('answers a preflight with the same headers', async () => {
    const res = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://unstream.stream');
  });
});

describe('a failed query fails the response', () => {
  it('500s instead of rendering zeros when one aggregate errors', async () => {
    mocks.mockRpc.mockImplementation((fn: string, args: ContextArgs) =>
      fn === 'analytics_daily_events'
        ? Promise.resolve({ data: null, error: { message: 'function analytics_daily_events does not exist' } })
        : rpcResult(fn, args)
    );
    const res = await get();
    // The old code logged a partial failure and returned 200 with a chart full of zeros.
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to fetch analytics' });
  });

  it('500s when one breakdown errors', async () => {
    mocks.mockRpc.mockImplementation((fn: string, args: ContextArgs) =>
      fn === 'analytics_context_counts' && args.p_key === 'browser'
        ? Promise.resolve({ data: null, error: { message: 'timeout' } })
        : rpcResult(fn, args)
    );
    const res = await get();
    expect(res.statusCode).toBe(500);
  });
});
