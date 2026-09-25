// /admin/analytics reported 641 of 10,380 searches in production on 2026-08-23. Every aggregate
// was a raw app_events read counted in a JS loop, and PostgREST silently truncated each one at
// 1,000 rows — `by_app` and `streaming_services` both totalled *exactly* 1000, which is the tell.
// The daily query ordered created_at ASC, so the 1,000 rows that survived were the oldest and the
// most recent 26 days rendered as zero.
//
// These tests pin the two properties that fix depends on: the counts come from the analytics_*
// SQL functions (so no row cap is in the path), and the per-group counts are *summed* rather than
// incremented by one per row.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({
    // Every count query is .from().select().eq().gte()
    from: () => ({ select: mocks.mockSelect }),
    rpc: mocks.mockRpc,
  }),
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
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

import { handler } from '../analytics-dashboard';

const today = new Date().toISOString().split('T')[0];

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
  ],
  analytics_platform_clicks: [
    { platform: 'bandcamp', clicks: 1800 },
    { platform: 'mirlo', clicks: 300 },
  ],
  analytics_streaming_services: [
    { service: 'youtube', activations: 1200 },
    { service: 'spotify', activations: 300 },
  ],
  // `ko-fi` is what the web app's unclaimed-artist path records for a Ko-fi click (the lowercased
  // display name); everything else records the source id `kofi`.
  analytics_platform_clicks_by_app: [
    { app: 'extension', platform: 'kofi', clicks: 40 },
    { app: 'mac', platform: 'patreon', clicks: 25 },
    { app: 'web', platform: 'ko-fi', clicks: 10 },
    { app: 'web', platform: 'kofi', clicks: 5 },
  ],
};

function get(headers: Record<string, string | undefined> = {}) {
  return handler({ httpMethod: 'GET', headers: { authorization: 'Bearer t', ...headers } });
}

async function body() {
  const res = await get();
  return JSON.parse(res.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockSelect.mockReturnValue({
    eq: () => ({ gte: () => Promise.resolve({ count: 10380, error: null }) }),
  });
  mocks.mockRpc.mockImplementation((fn: string) =>
    Promise.resolve({ data: RPC_DATA[fn] ?? [], error: null })
  );
});

describe('aggregation happens in Postgres', () => {
  it('asks the analytics_* functions for every breakdown', async () => {
    await get();
    expect(mocks.mockRpc.mock.calls.map(c => c[0]).sort()).toEqual([
      'analytics_daily_events',
      'analytics_events_by_app',
      'analytics_platform_clicks',
      'analytics_platform_clicks_by_app',
      'analytics_search_success',
      'analytics_streaming_services',
    ]);
  });

  it('sums the grouped counts instead of counting rows', async () => {
    const d = await body();
    const bucket = d.daily.find((r: { date: string }) => r.date === today);
    // A regression to `bucket.searches++` would make these 1, 1 and 1.
    expect(bucket).toMatchObject({ searches: 7400, clicks: 2100, activations: 1500 });
    expect(d.by_app.find((a: { app: string }) => a.app === 'web'))
      .toMatchObject({ searches: 5000, clicks: 2100 });
    expect(d.platforms[0]).toEqual({ platform: 'bandcamp', clicks: 1800 });
    expect(d.streaming_services[0]).toEqual({ service: 'youtube', activations: 1200 });
  });

  it('reports the chart total the exact count already agrees with', async () => {
    const d = await body();
    const charted = d.daily.reduce((n: number, r: { searches: number }) => n + r.searches, 0);
    expect(d.summary.searches_30d).toBe(10380);
    // The production symptom was these two disagreeing by 16x.
    expect(charted).toBe(7400);
  });

  it('derives the success rate from the function’s two totals', async () => {
    const d = await body();
    expect(d.summary.success_rate_7d).toBe(75);
  });

  it('reports no success rate rather than a wrong one when nothing completed', async () => {
    mocks.mockRpc.mockImplementation((fn: string) =>
      Promise.resolve({
        data: fn === 'analytics_search_success' ? [{ completed: 0, with_results: 0 }] : RPC_DATA[fn] ?? [],
        error: null,
      })
    );
    const d = await body();
    expect(d.summary.success_rate_7d).toBeNull();
  });
});

describe('patronage clicks (tips demand test)', () => {
  function patronageArgs() {
    const call = mocks.mockRpc.mock.calls.find(c => c[0] === 'analytics_platform_clicks_by_app');
    return call?.[1] as { p_since: string; p_platforms: string[] };
  }

  it('asks for exactly the registry’s patronage platforms, under both spellings', async () => {
    const { PLATFORMS } = await import('../../shared/platform-registry');
    await get();
    const requested = patronageArgs().p_platforms;
    for (const [id, meta] of Object.entries(PLATFORMS)) {
      const expected = meta.category === 'patronage';
      expect(requested.includes(id)).toBe(expected);
      expect(requested.includes(meta.name.toLowerCase())).toBe(expected);
    }
    expect(requested).toContain('kofi');
    expect(requested).toContain('ko-fi');
    expect(requested).not.toContain('bandcamp');
  });

  it('reads the same 30-day window as the rest of the dashboard', async () => {
    await get();
    const since = Date.parse(patronageArgs().p_since);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(Date.now() - thirtyDays - since)).toBeLessThan(60_000);
  });

  it('breaks the clicks down by app and by platform, folding the web spelling into the id', async () => {
    const d = await body();
    expect(d.patronage_clicks.total).toBe(80);
    expect(d.patronage_clicks.by_platform).toEqual([
      { platform: 'kofi', clicks: 55 },
      { platform: 'patreon', clicks: 25 },
    ]);
    expect(d.patronage_clicks.by_app).toEqual([
      { app: 'extension', clicks: 40, all_clicks: 0 },
      { app: 'mac', clicks: 25, all_clicks: 0 },
      { app: 'web', clicks: 15, all_clicks: 2100 },
    ]);
  });

  it('lists every app at zero rather than hiding them when nobody clicked', async () => {
    mocks.mockRpc.mockImplementation((fn: string) =>
      Promise.resolve({
        data: fn === 'analytics_platform_clicks_by_app' ? [] : RPC_DATA[fn] ?? [],
        error: null,
      })
    );
    const d = await body();
    expect(d.patronage_clicks.total).toBe(0);
    expect(d.patronage_clicks.by_platform).toEqual([]);
    expect(d.patronage_clicks.by_app.map((a: { app: string }) => a.app).sort())
      .toEqual(['extension', 'mac', 'web']);
  });

  it('500s rather than reporting zero patronage clicks when the query fails', async () => {
    mocks.mockRpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'analytics_platform_clicks_by_app'
          ? { data: null, error: { message: 'function does not exist' } }
          : { data: RPC_DATA[fn] ?? [], error: null }
      )
    );
    const res = await get();
    // A zero here would read as "nobody wants to tip" — the go/no-go answer — when the
    // migration simply hadn't applied.
    expect(res.statusCode).toBe(500);
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
    mocks.mockRpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'analytics_daily_events'
          ? { data: null, error: { message: 'function analytics_daily_events does not exist' } }
          : { data: RPC_DATA[fn] ?? [], error: null }
      )
    );
    const res = await get();
    // The old code logged a partial failure and returned 200 with a chart full of zeros.
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to fetch analytics' });
  });

  it('500s when a count query errors', async () => {
    mocks.mockSelect.mockReturnValue({
      eq: () => ({ gte: () => Promise.resolve({ count: null, error: { message: 'timeout' } }) }),
    });
    const res = await get();
    expect(res.statusCode).toBe(500);
  });
});
