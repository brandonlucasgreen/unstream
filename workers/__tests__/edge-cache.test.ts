import { describe, it, expect, vi, beforeEach } from 'vitest';

import { withEdgeCache } from '../edge-cache.ts';

/**
 * A Worker's response is cached only when the Worker stores it, so every rule about *what* gets
 * stored lives in this one function. The two that matter most are the two that fail quietly:
 * storing a fall-through would pin a blank page to a release URL for an hour, and handing a
 * cache hit back with the CDN's hour-long policy would park a release page in the visitor's own
 * browser for an hour.
 */
const store = new Map<string, Response>();

const cache = {
  match: vi.fn(async (request: Request) => {
    const hit = store.get(request.url);
    return hit ? hit.clone() : undefined;
  }),
  put: vi.fn(async (request: Request, response: Response) => {
    store.set(request.url, response);
  }),
};

vi.stubGlobal('caches', { default: cache });

/** A stand-in ExecutionContext that runs waitUntil work immediately, so puts are observable. */
const ctx = { waitUntil: (work: Promise<unknown>) => work, passThroughOnException: () => {} } as unknown as ExecutionContext;

const URL_UNDER_TEST = 'https://unstream.stream/a/mono/hymn';

function releasePage(body = 'page'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      'Cache-Tag': 'release-mono-hymn,artist-releases-mono',
    },
  });
}

beforeEach(() => {
  store.clear();
  cache.match.mockClear();
  cache.put.mockClear();
});

describe('what gets stored', () => {
  it('stores a page that asked to be cached', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('stores the CDN policy as the entry’s Cache-Control, which is all the Cache API reads', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    const stored = store.get(URL_UNDER_TEST)!;
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
  });

  it('leaves a hit and a miss byte-identical to the client', async () => {
    const miss = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());
    const hit = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Cache-Tag', 'Content-Type']) {
      expect(hit.headers.get(header), header).toBe(miss.headers.get(header));
    }
  });

  it('keeps the Cache-Tag, which is what a purge finds the entry by', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    expect(store.get(URL_UNDER_TEST)!.headers.get('Cache-Tag')).toBe('release-mono-hymn,artist-releases-mono');
  });

  it('never stores a page that did not ask — a fall-through is what a database timeout looks like', async () => {
    const fallThrough = new Response('<spa shell>', { status: 200, headers: { 'CDN-Cache-Control': 'no-store' } });

    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => fallThrough);

    expect(cache.put).not.toHaveBeenCalled();
  });

  it('never stores a response with no CDN policy at all', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => new Response('x', { status: 200 }));

    expect(cache.put).not.toHaveBeenCalled();
  });

  it('never stores a non-200', async () => {
    const notFound = new Response('gone', { status: 404, headers: { 'CDN-Cache-Control': 'public, s-maxage=3600' } });

    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => notFound);

    expect(cache.put).not.toHaveBeenCalled();
  });

  it.each(['private, s-maxage=3600', 'no-cache, s-maxage=3600', 'public, no-store'])(
    'never stores a policy the Cache API would refuse: %s',
    async (policy) => {
      // put() rejects these silently from inside waitUntil, which would leave the route looking
      // cached while every hit stayed a miss.
      const refused = new Response('x', { status: 200, headers: { 'CDN-Cache-Control': policy } });

      await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => refused);

      expect(cache.put).not.toHaveBeenCalled();
    },
  );

  it('never stores a response that says it is never reusable (Vary: *)', async () => {
    const varied = new Response('x', {
      status: 200,
      headers: { 'CDN-Cache-Control': 'public, s-maxage=3600', Vary: '*' },
    });

    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => varied);

    expect(cache.put).not.toHaveBeenCalled();
  });

  it('survives a cache.put that rejects, without failing the response', async () => {
    cache.put.mockRejectedValueOnce(new Error('413 payload too large'));

    const response = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('page');
  });

  it('never stores a response carrying a cookie', async () => {
    const personal = new Response('x', {
      status: 200,
      headers: { 'CDN-Cache-Control': 'public, s-maxage=3600', 'Set-Cookie': 'session=abc' },
    });

    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => personal);

    expect(cache.put).not.toHaveBeenCalled();
  });

  it('does not touch the cache for a non-GET', async () => {
    const render = vi.fn(async () => releasePage());

    await withEdgeCache(new Request(URL_UNDER_TEST, { method: 'POST' }), ctx, render);

    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe('what a visitor gets back', () => {
  it('gives the browser its own short policy on a miss, not the CDN’s', async () => {
    const response = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('gives the browser its own short policy on a HIT too', async () => {
    // The regression this guards: the stored copy carries the CDN's hour-long policy, so handing
    // it back unchanged would park a release page in the visitor's browser for an hour.
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage());
    const hit = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage('should not run'));

    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(hit.headers.get('x-browser-cache-control')).toBeNull();
  });

  it('does not invent a browser policy for a page that declared none', async () => {
    // The stored copy carries the CDN policy in Cache-Control because that is all the Cache API
    // reads. Handing it back unchanged would tell the browser `public, s-maxage=3600` for a page
    // that was served with no caching instructions at all.
    const noBrowserPolicy = new Response('x', {
      status: 200,
      headers: { 'CDN-Cache-Control': 'public, s-maxage=3600' },
    });

    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => noBrowserPolicy.clone());
    const hit = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => noBrowserPolicy.clone());

    expect(hit.headers.get('Cache-Control')).toBeNull();
  });

  it('serves the stored body on a hit without rendering again', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage('first render'));

    const render = vi.fn(async () => releasePage('second render'));
    const hit = await withEdgeCache(new Request(URL_UNDER_TEST), ctx, render);

    expect(await hit.text()).toBe('first render');
    expect(render).not.toHaveBeenCalled();
  });

  it('keys entries by URL, so two releases do not share one', async () => {
    await withEdgeCache(new Request(URL_UNDER_TEST), ctx, async () => releasePage('hymn'));
    const other = await withEdgeCache(
      new Request('https://unstream.stream/a/mono/walking-cloud'),
      ctx,
      async () => releasePage('walking cloud'),
    );

    expect(await other.text()).toBe('walking cloud');
  });
});
