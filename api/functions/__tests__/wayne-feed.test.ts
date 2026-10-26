// /digest/wayne.xml relays Wayne's weekly digest (wayne-digest.xml on the industry-digest
// branch). Same contract as digest-feed.test.ts: RSS Content-Type (GitHub serves text/plain),
// noindex, and a GitHub failure is never cached or relayed as if it were the feed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('../../lib/sentry', () => ({ withSentry: (handler: unknown) => handler, Sentry: { captureMessage: mocks.captureMessage } }));

import { handler, UPSTREAM_URL } from '../wayne-feed';
import { isUrlHostnameAllowed } from '../middleware';

const FEED = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel></channel></rss>\n';

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mocks.captureMessage.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wayne-feed', () => {
  it('points at the wayne-digest file on the industry-digest branch and passes the SSRF allowlist', () => {
    expect(UPSTREAM_URL).toContain('industry-digest/wayne-digest.xml');
    expect(isUrlHostnameAllowed(UPSTREAM_URL)).toBe(true);
  });

  it('relays the feed as RSS, noindexed and CDN-cached', async () => {
    const fetchMock = stubFetch(async () => new Response(FEED, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const res = await handler({ httpMethod: 'GET' });

    expect(fetchMock).toHaveBeenCalledWith(UPSTREAM_URL, expect.anything());
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(FEED);
    expect(res.headers['Content-Type']).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(res.headers['CDN-Cache-Control']).toContain('s-maxage=3600');
  });

  it('404s, uncached, before the first issue exists', async () => {
    stubFetch(async () => new Response('404: Not Found', { status: 404 }));
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('502s, uncached and reported, when GitHub does not answer', async () => {
    stubFetch(async () => {
      throw new Error('timeout');
    });
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(502);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      'Wayne digest feed: GitHub did not answer',
      expect.anything(),
    );
  });

  it('rejects non-GET methods', async () => {
    const res = await handler({ httpMethod: 'POST' });
    expect(res.statusCode).toBe(405);
  });
});
