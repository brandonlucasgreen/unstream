// /api/analytics/traffic: GoatCounter's numbers for the range the search dashboard shows. Pins the
// request it makes (token, inclusive end), the shape it hands the page, and that a GoatCounter
// failure reads as "couldn't ask", never as zero visitors.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware', async importOriginal => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: async () => ({ userId: 'u1', email: 'admin@example.com' }),
}));
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

import { handler } from '../analytics-traffic';

const fetchMock = vi.fn();
const originalEnv = { ...process.env };

const RESPONSES: Record<string, unknown> = {
  '/stats/total': {
    total: 1290,
    total_utc: 1300,
    stats: [{ day: '2026-10-01', daily: 600 }, { day: '2026-10-02', daily: 700 }],
  },
  '/stats/hits': {
    hits: [
      { path: '/', title: 'Unstream', event: false, count: 900 },
      { path: '/go/bandcamp', title: '', event: true, count: 400 },
      { path: '/a/kid-lightbulbs', title: 'Kid Lightbulbs', event: false, count: 50 },
    ],
  },
  '/stats/toprefs': {
    stats: [{ name: '', count: 500 }, { name: 'Google', count: 300 }],
  },
};

function get() {
  return handler({
    httpMethod: 'GET',
    headers: { authorization: 'Bearer t' },
    queryStringParameters: { from: '2026-10-01', to: '2026-10-02' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, GOATCOUNTER_API_TOKEN: 'gc-token' };
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname.replace('/api/v0', '');
    return new Response(JSON.stringify(RESPONSES[path]), { status: 200 });
  });
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('analytics-traffic', () => {
  it('asks GoatCounter for the whole of both end days, with the token', async () => {
    await get();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.host).toBe('unstream.goatcounter.com');
      expect(parsed.searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z');
      expect(parsed.searchParams.get('end')).toBe('2026-10-02T23:59:59Z');
      expect(init.headers.Authorization).toBe('Bearer gc-token');
    }
  });

  it('reports UTC visitors, pages without events, and named referrers', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      visitors: 1300,
      chart: [{ date: '2026-10-01', visitors: 600 }, { date: '2026-10-02', visitors: 700 }],
      top_pages: [
        { path: '/', title: 'Unstream', visitors: 900 },
        { path: '/a/kid-lightbulbs', title: 'Kid Lightbulbs', visitors: 50 },
      ],
      top_referrers: [{ name: '(direct)', visitors: 500 }, { name: 'Google', visitors: 300 }],
    });
  });

  it('says it is not configured, without calling GoatCounter, when there is no token', async () => {
    delete process.env.GOATCOUNTER_API_TOKEN;
    const res = await get();
    expect(JSON.parse(res.body)).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails loudly rather than reporting zero visitors when GoatCounter errors', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429 }));
    const res = await get();
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'GoatCounter did not answer' });
  });
});
