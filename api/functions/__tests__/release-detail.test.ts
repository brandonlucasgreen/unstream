// The release JSON endpoint.
//
// What matters here is not that a happy path serializes. It's the handful of properties a native
// client depends on and can't check for itself:
//
//   - `payoutPercent` comes from the server, including the Bandcamp Friday override. This is the
//     whole reason the field exists: payout figures are hand-mirrored in eight files, and that
//     drift is what let the Discord bot quote an unsourced Jam.coop figure for months (#389).
//   - Sources are ordered artist-paying-first, so a secondhand marketplace can never lead over a
//     direct purchase from the artist.
//   - A failed lookup is a 503 that is never cached, not a 404. This response carries a CDN
//     s-maxage, so a 404 on an outage would be a convincing lie the CDN then holds.
//
// The two query-level properties — `is_hidden` filtered, `needs_review` deliberately not — can't
// be seen from here, because this file mocks `../db` out. They're covered in
// release-detail-query.test.ts, which drives the real `getReleaseDetail` instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '1.2.3.4'),
  getReleaseDetail: vi.fn(),
  isBandcampFriday: vi.fn(() => false),
  captureMessage: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));
vi.mock('../db', () => ({ getReleaseDetail: mocks.getReleaseDetail }));
vi.mock('../../shared/bandcamp-friday', () => ({ isBandcampFriday: mocks.isBandcampFriday }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureMessage: mocks.captureMessage } }));

import { handler } from '../release-detail';
import { PLATFORMS } from '../../shared/platform-registry';

type Offer = {
  format: string;
  price: number | null;
  currency: string | null;
  availability: string;
  capturedAt: string;
};

function offer(over: Partial<Offer> = {}): Offer {
  return {
    format: 'digital',
    price: 9,
    currency: 'USD',
    availability: 'available',
    capturedAt: '2026-08-01T09:00:00.000Z',
    ...over,
  };
}

function source(over: Record<string, unknown> = {}) {
  return {
    platform: 'bandcamp',
    url: 'https://boyharsher.bandcamp.com/album/get-mean',
    detailCheckedAt: '2026-08-01T09:00:00.000Z',
    offers: [offer()],
    ...over,
  };
}

/** Shaped like a real row: GET MEAN as it actually comes back from production. */
function detail(over: Record<string, unknown> = {}) {
  return {
    artist: { slug: 'boy-harsher', name: 'Boy Harsher', imageUrl: null },
    release: {
      slug: 'get-mean',
      title: 'GET MEAN',
      releaseType: 'album',
      releaseDate: '2026-09-18',
      datePrecision: 'day',
      status: 'announced',
      artworkUrl: 'https://f4.bcbits.com/img/a0780870664_2.jpg',
      sources: [source()],
      ...over,
    },
  };
}

function get(params: Record<string, string> | null = { artist: 'boy-harsher', release: 'get-mean' }) {
  return handler({
    httpMethod: 'GET',
    queryStringParameters: params,
    headers: { 'x-nf-client-connection-ip': '1.2.3.4' },
  });
}

async function body(res: { body: string }) {
  return JSON.parse(res.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.isBandcampFriday.mockReturnValue(false);
  mocks.getReleaseDetail.mockResolvedValue({ detail: detail(), failed: false });
});

describe('routing and input', () => {
  // The slugs arrive as query params because netlify.toml substitutes them into the rewrite
  // target — `event.path` is the rewrite target behind a status-200 rewrite and carries nothing.
  it('reads both slugs from the query string and passes them to the lookup', async () => {
    await get({ artist: 'kid-lightbulbs', release: 'fruit-is-year-3-honeycrush' });
    expect(mocks.getReleaseDetail).toHaveBeenCalledWith('kid-lightbulbs', 'fruit-is-year-3-honeycrush');
  });

  it('400s when either slug is missing, without querying', async () => {
    expect((await get({ artist: 'boy-harsher' })).statusCode).toBe(400);
    expect((await get({ release: 'get-mean' })).statusCode).toBe(400);
    expect((await get(null)).statusCode).toBe(400);
    expect(mocks.getReleaseDetail).not.toHaveBeenCalled();
  });

  // A slug we never minted can't exist, so it 404s without costing a database round trip.
  it.each([
    ['uppercase', { artist: 'Boy-Harsher', release: 'get-mean' }],
    ['a path traversal', { artist: '../../etc', release: 'get-mean' }],
    ['a leading hyphen', { artist: '-boy-harsher', release: 'get-mean' }],
    ['an over-long slug', { artist: 'a'.repeat(200), release: 'get-mean' }],
    ['junk in the release slug', { artist: 'boy-harsher', release: 'get mean?x=1' }],
  ])('404s on %s without querying', async (_label, params) => {
    const res = await get(params);
    expect(res.statusCode).toBe(404);
    expect(mocks.getReleaseDetail).not.toHaveBeenCalled();
  });

  it('accepts the slug shapes production actually contains', async () => {
    for (const release of ['get-mean', 'fruit-is-year-3-honeycrush', 'release-a1b2c3d4', '4']) {
      mocks.getReleaseDetail.mockClear();
      await get({ artist: 'boy-harsher', release });
      expect(mocks.getReleaseDetail).toHaveBeenCalledWith('boy-harsher', release);
    }
  });

  it('answers the CORS preflight and rejects non-GET methods', async () => {
    const preflight = await handler({ httpMethod: 'OPTIONS' });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('*');

    const post = await handler({ httpMethod: 'POST', queryStringParameters: { artist: 'a', release: 'b' } });
    expect(post.statusCode).toBe(405);
    expect(mocks.getReleaseDetail).not.toHaveBeenCalled();
  });

  // The Mac app and the extension send no Origin the shared allowlist accepts, so this endpoint
  // carries the same deliberate wildcard check-releases.ts does.
  it('serves a wildcard origin so native clients can call it', async () => {
    expect((await get()).headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('honours the rate limiter', async () => {
    const limited = { statusCode: 429, headers: {}, body: '{}' };
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: limited });

    expect(await get()).toBe(limited);
    expect(mocks.getReleaseDetail).not.toHaveBeenCalled();
    // 'lenient': a person tapping through a few records is not abuse.
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('1.2.3.4', 'lenient', expect.anything());
  });

  // `response` is optional on the limiter's result type. Returning it unchecked would serve a
  // rate-limited request as an empty 200 — the opposite of being limited.
  it('still refuses when the limiter reports a limit but hands back no response', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true });

    const res = await get();
    expect(res.statusCode).toBe(429);
    expect(mocks.getReleaseDetail).not.toHaveBeenCalled();
  });
});

describe('absence versus failure', () => {
  it('404s a release that genuinely is not there', async () => {
    mocks.getReleaseDetail.mockResolvedValue({ detail: null, failed: false });
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.headers['Netlify-CDN-Cache-Control']).toBeUndefined();
  });

  // A Supabase outage must not render as "this release doesn't exist" — and must not be cached
  // for five minutes by the CDN while it does. Never cache uncertainty.
  it('503s, uncached, when the lookup itself failed', async () => {
    mocks.getReleaseDetail.mockResolvedValue({ detail: null, failed: true });
    const res = await get();

    expect(res.statusCode).toBe(503);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Netlify-CDN-Cache-Control']).toBeUndefined();
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('500s rather than leaking an exception', async () => {
    mocks.getReleaseDetail.mockRejectedValue(new Error('boom'));
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
  });
});

describe('the payload', () => {
  it('returns the release, its artist and the page URL', async () => {
    const res = await get();
    const json = await body(res);

    expect(res.statusCode).toBe(200);
    expect(json.artist).toEqual({ slug: 'boy-harsher', name: 'Boy Harsher', imageUrl: null });
    expect(json.release.title).toBe('GET MEAN');
    expect(json.release.status).toBe('announced');
    expect(json.release.releaseDate).toBe('2026-09-18');
    expect(json.release.datePrecision).toBe('day');
    expect(json.pageUrl).toBe('https://unstream.stream/a/boy-harsher/get-mean');
  });

  it('caches at the CDN, since this is public data', async () => {
    const res = await get();
    expect(res.headers['Netlify-CDN-Cache-Control']).toContain('s-maxage=300');
    expect(res.headers['Cache-Tag']).toBe('release-detail-boy-harsher-get-mean');
  });

  // The reason the field exists at all: a client that reads the number off the response cannot
  // drift from the registry the way four hand-mirrored copies did.
  it('returns each platform name and payout from the registry', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({ sources: [source({ platform: 'jamcoop', url: 'https://jam.coop/x' })] }),
      failed: false,
    });

    const [src] = (await body(await get())).release.sources;
    expect(src.name).toBe('Jam.coop');
    // 82-85%, per PR #389 — and specifically not the unsourced '86-95%' the Discord bot quoted.
    expect(src.payoutPercent).toBe('82-85%');
  });

  it('falls back to the raw id and a null payout for a platform not in the registry', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({ sources: [source({ platform: 'not-a-real-platform' })] }),
      failed: false,
    });

    const [src] = (await body(await get())).release.sources;
    expect(src.name).toBe('not-a-real-platform');
    expect(src.payoutPercent).toBeNull();
  });

  // Bandcamp waives its revenue share on a Bandcamp Friday, so the registry's usual range is
  // wrong for 24 hours. The HTML page already overrides it and no client knows that.
  it('overrides Bandcamp to ~97% on a Bandcamp Friday, and flags it', async () => {
    mocks.isBandcampFriday.mockReturnValue(true);
    const json = await body(await get());

    expect(json.bandcampFriday).toBe(true);
    expect(json.release.sources[0].payoutPercent).toBe('~97%');
    expect(json.release.sources[0].bandcampFriday).toBe(true);
  });

  it('leaves other platforms alone on a Bandcamp Friday', async () => {
    mocks.isBandcampFriday.mockReturnValue(true);
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({ sources: [source({ platform: 'mirlo' })] }),
      failed: false,
    });

    const [src] = (await body(await get())).release.sources;
    // Asserted against the registry, not a copy of the number — a literal here would be the
    // eighth hand-mirrored payout table, which is the thing this endpoint exists to stop.
    expect(src.payoutPercent).toBe(PLATFORMS.mirlo.payoutPercent);
    expect(src.payoutPercent).not.toBe('~97%');
    expect(src.bandcampFriday).toBe(false);
  });

  it('reports the usual Bandcamp range when it is not a Bandcamp Friday', async () => {
    const json = await body(await get());
    expect(json.bandcampFriday).toBe(false);
    expect(json.release.sources[0].payoutPercent).toBe('80-85%');
    expect(json.release.sources[0].bandcampFriday).toBe(false);
  });
});

describe('ordering', () => {
  // Artist-paying first. Faircamp (90-97%) above Bandcamp (80-85%) is the real Kid Lightbulbs
  // case; the point generalizes to Discogs, whose secondhand listings must never lead.
  it('orders sources artist-paying-first regardless of input order', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [
          source({ platform: 'bandcamp' }),
          source({ platform: 'faircamp', url: 'https://music.kidlightbulbs.com/fiy3/' }),
        ],
      }),
      failed: false,
    });

    const json = await body(await get());
    expect(json.release.sources.map((s: { platform: string }) => s.platform)).toEqual(['faircamp', 'bandcamp']);
  });

  it('ranks an unknown platform last rather than first', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [source({ platform: 'not-a-real-platform' }), source({ platform: 'bandcamp' })],
      }),
      failed: false,
    });

    const json = await body(await get());
    expect(json.release.sources.map((s: { platform: string }) => s.platform))
      .toEqual(['bandcamp', 'not-a-real-platform']);
  });

  it('orders offers by availability, then cheapest first', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [source({
          offers: [
            offer({ format: 'vinyl', price: 30 }),
            offer({ format: 'cassette', price: 15, availability: 'sold_out' }),
            offer({ format: 'digital', price: 9 }),
            offer({ format: 'cd', price: 15 }),
            offer({ format: 'book', price: 40, availability: 'preorder' }),
          ],
        })],
      }),
      failed: false,
    });

    const json = await body(await get());
    expect(json.release.sources[0].offers.map((o: { format: string }) => o.format))
      .toEqual(['digital', 'cd', 'vinyl', 'book', 'cassette']);
  });

  it('sorts a null price last within its availability band rather than treating it as free', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [source({
          offers: [offer({ format: 'vinyl', price: null }), offer({ format: 'digital', price: 9 })],
        })],
      }),
      failed: false,
    });

    const json = await body(await get());
    expect(json.release.sources[0].offers.map((o: { format: string }) => o.format))
      .toEqual(['digital', 'vinyl']);
  });
});

describe('offers and freshness', () => {
  // Zero means name-your-price, not free — every Kid Lightbulbs release is one. The number is
  // passed through untouched so a client can render "Name your price" rather than "$0".
  it('passes a zero price through instead of dropping or defaulting it', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({ sources: [source({ platform: 'faircamp', offers: [offer({ price: 0 })] })] }),
      failed: false,
    });

    const [offerOut] = (await body(await get())).release.sources[0].offers;
    expect(offerOut.price).toBe(0);
    expect(offerOut.currency).toBe('USD');
  });

  // "No formats listed" and "we have never read this page" are different facts, and the release
  // page says different things for them. A client needs the same distinction.
  it('keeps an empty offer list distinguishable from a never-read source', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [
          source({ platform: 'faircamp', offers: [], detailCheckedAt: '2026-08-01T09:00:00.000Z' }),
          source({ platform: 'bandcamp', offers: [], detailCheckedAt: null }),
        ],
      }),
      failed: false,
    });

    const byPlatform: Record<string, { detailCheckedAt: string | null; offers: unknown[] }> = {};
    for (const s of (await body(await get())).release.sources) byPlatform[s.platform] = s;

    expect(byPlatform.faircamp.detailCheckedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(byPlatform.faircamp.offers).toEqual([]);
    expect(byPlatform.bandcamp.detailCheckedAt).toBeNull();
  });

  // The *oldest* capture across every source. Claiming "checked today" because one source was
  // re-read would overstate the rest.
  it('reports the oldest capture across all sources as the freshness claim', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({
        sources: [
          source({ platform: 'bandcamp', offers: [offer({ capturedAt: '2026-08-01T00:00:00.000Z' })] }),
          source({ platform: 'faircamp', offers: [offer({ capturedAt: '2026-07-04T00:00:00.000Z' })] }),
        ],
      }),
      failed: false,
    });

    expect((await body(await get())).release.pricesCheckedAt).toBe('2026-07-04T00:00:00.000Z');
  });

  it('reports null freshness rather than a date when nothing has been captured', async () => {
    mocks.getReleaseDetail.mockResolvedValue({
      detail: detail({ sources: [source({ offers: [], detailCheckedAt: null })] }),
      failed: false,
    });

    expect((await body(await get())).release.pricesCheckedAt).toBeNull();
  });

  it('serves a release with no sources at all rather than 404ing it', async () => {
    mocks.getReleaseDetail.mockResolvedValue({ detail: detail({ sources: [] }), failed: false });
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect((await body(res)).release.sources).toEqual([]);
  });
});
