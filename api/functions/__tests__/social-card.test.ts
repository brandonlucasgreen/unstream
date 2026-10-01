// The Instagram card endpoint. What matters is what a card can be made to say and fetch: only a
// claimed artist, only a platform they link to, only a release in their catalogue there, only
// images from allowlisted hosts — and that a host or database that didn't answer is never cached
// as "nothing to draw". The renderer runs for real, so a passing render is a real PNG.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getArtistProfileBySlug: vi.fn(),
  getArtistReleases: vi.fn(),
  checkRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  captureException: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../db', () => ({
  getArtistProfileBySlug: mocks.getArtistProfileBySlug,
  getArtistReleases: mocks.getArtistReleases,
  getClient: () => null,
}));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException, captureMessage: vi.fn() },
}));

import { handler } from '../social-card';

// A valid 1×1 PNG, enough for resvg to decode and draw.
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP_HEADER = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'binary');

function bundle(overrides: { artist?: Record<string, unknown>; profile?: Record<string, unknown> | null; links?: { platform: string; url: string }[] } = {}) {
  return {
    bundle: {
      artist: {
        id: 'artist-1',
        slug: 'kid-lightbulbs',
        name: 'Kid Lightbulbs',
        image_url: 'https://f4.bcbits.com/img/0032895476_23.jpg',
        match_confidence: 'claimed',
        city: 'Boston',
        country: 'United States',
        ...overrides.artist,
      },
      profile: overrides.profile === undefined
        ? { verified_at: '2026-01-01T00:00:00Z', custom_image_url: null }
        : overrides.profile,
      links: overrides.links ?? [{ platform: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' }],
    },
    failed: false,
  };
}

const RELEASES = [
  {
    slug: 'any-day-now',
    title: 'any day now',
    releaseType: 'album',
    releaseDate: '2026-09-03',
    status: 'released',
    artworkUrl: 'https://f4.bcbits.com/img/a1011057568_2.jpg',
    sources: [{ platform: 'bandcamp' }],
  },
  {
    slug: 'older',
    title: 'Older',
    releaseType: 'single',
    releaseDate: '2024-01-01',
    status: 'released',
    artworkUrl: 'https://f4.bcbits.com/img/a1_2.jpg',
    sources: [{ platform: 'bandcamp' }],
  },
  {
    slug: 'elsewhere',
    title: 'Elsewhere',
    releaseType: 'album',
    releaseDate: '2026-01-01',
    status: 'released',
    artworkUrl: 'https://f4.bcbits.com/img/a2_2.jpg',
    sources: [{ platform: 'mirlo' }],
  },
];

function request(slide: string, query: Record<string, string> = { platform: 'bandcamp' }, slug = 'kid-lightbulbs') {
  return handler({ httpMethod: 'GET', headers: {}, path: `/api/social-card/${slug}/${slide}.png`, queryStringParameters: query });
}

function imageResponse(bytes: Buffer, status = 200) {
  return new Response(new Uint8Array(bytes), { status });
}

function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.subarray(0, 4).toString('binary')).toBe('\x89PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArtistProfileBySlug.mockResolvedValue(bundle());
  mocks.getArtistReleases.mockResolvedValue({ releases: RELEASES, total: RELEASES.length });
  mocks.fetch.mockImplementation(async () => imageResponse(PIXEL_PNG));
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('social-card: what gets drawn', () => {
  it('draws the buy slide as a 1080×1350 PNG, cached for a month', async () => {
    const res = await request('buy');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Netlify-CDN-Cache-Control']).toContain('s-maxage=2592000');
    expect(res.isBase64Encoded).toBe(true);
    expect(pngSize(res.body)).toEqual({ width: 1080, height: 1350 });
    // Nothing on this slide comes from an image host.
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('draws the record named in the URL, fetching its full-size cover without following redirects', async () => {
    const res = await request('record', { platform: 'bandcamp', release: 'any-day-now' });
    expect(res.statusCode).toBe(200);
    expect(pngSize(res.body)).toEqual({ width: 1080, height: 1350 });
    expect(mocks.fetch).toHaveBeenCalledWith('https://f4.bcbits.com/img/a1011057568_10.jpg', expect.objectContaining({ redirect: 'error' }));
  });

  it('draws a name full of XML specials without breaking the SVG', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({ artist: { name: `Tom & Jerry <3 "Live" 'n' >` } }));
    const res = await request('buy');
    expect(res.statusCode).toBe(200);
  });

  it('draws the math slide and the photo slide', async () => {
    expect((await request('math')).statusCode).toBe(200);
    const photo = await request('photo');
    expect(photo.statusCode).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith('https://f4.bcbits.com/img/0032895476_10.jpg', expect.anything());
  });

  it("prefers the artist's own image, as their page does", async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({
      profile: { verified_at: '2026-01-01T00:00:00Z', custom_image_url: 'https://f4.bcbits.com/img/0099_23.jpg' },
    }));
    await request('photo');
    expect(mocks.fetch).toHaveBeenCalledWith('https://f4.bcbits.com/img/0099_10.jpg', expect.anything());
  });
});

describe('social-card: what it refuses to draw', () => {
  it('only draws for claimed artists', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({ artist: { match_confidence: 'verified' } }));
    expect((await request('buy')).statusCode).toBe(404);

    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({ profile: { verified_at: null, custom_image_url: null } }));
    expect((await request('buy')).statusCode).toBe(404);
  });

  it("won't say an artist is on a platform they don't link to", async () => {
    expect((await request('buy', { platform: 'mirlo' })).statusCode).toBe(404);

    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({ links: [{ platform: 'bandcamp', url: 'https://bandcamp.com/search?q=kid+lightbulbs' }] }));
    expect((await request('buy')).statusCode).toBe(404);
  });

  it("won't draw a release that isn't theirs on that platform", async () => {
    expect((await request('record', { platform: 'bandcamp', release: 'not-theirs' })).statusCode).toBe(404);
    expect((await request('record', { platform: 'bandcamp', release: 'elsewhere' })).statusCode).toBe(404);
    expect((await request('record', { platform: 'bandcamp' })).statusCode).toBe(404);
  });

  it('answers HEAD as it answers GET, for fetchers that check the type first', async () => {
    const res = await handler({ httpMethod: 'HEAD', headers: {}, path: '/api/social-card/kid-lightbulbs/buy.png', queryStringParameters: { platform: 'bandcamp' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
  });

  it('rejects a malformed URL before touching the database', async () => {
    expect((await request('buy', { platform: 'not-a-platform' })).statusCode).toBe(400);
    expect((await request('banner')).statusCode).toBe(400);
    expect((await request('record', { platform: 'bandcamp', release: '../../etc' })).statusCode).toBe(400);
    expect((await request('buy', { platform: 'bandcamp' }, 'Kid_Lightbulbs')).statusCode).toBe(400);
    expect(mocks.getArtistProfileBySlug).not.toHaveBeenCalled();
  });

  it('never fetches an image from a host off the allowlist', async () => {
    mocks.getArtistReleases.mockResolvedValue({
      releases: [{ ...RELEASES[0], artworkUrl: 'http://169.254.169.254/latest/meta-data/cover.jpg' }],
      total: 1,
    });
    const res = await request('record', { platform: 'bandcamp', release: 'any-day-now' });
    expect(res.statusCode).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("puts a photo on a slide only when it can say where it's from", async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue(bundle({
      profile: { verified_at: '2026-01-01T00:00:00Z', custom_image_url: 'https://images.example.com/me.jpg' },
    }));
    expect((await request('photo')).statusCode).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("treats an image it can't decode as missing, and caches that only briefly", async () => {
    mocks.fetch.mockImplementation(async () => imageResponse(WEBP_HEADER));
    const res = await request('photo');
    expect(res.statusCode).toBe(404);
    expect(res.headers['Netlify-CDN-Cache-Control']).toBe('public, s-maxage=300');
  });
});

describe("social-card: never caching an answer it didn't get", () => {
  it('a database that failed is a 502, not a 404, and is not cached', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: true });
    const res = await request('buy');
    expect(res.statusCode).toBe(502);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('an image host that errored or timed out is a 502, not cached', async () => {
    mocks.fetch.mockImplementation(async () => imageResponse(Buffer.from(''), 503));
    const failing = await request('photo');
    expect(failing.statusCode).toBe(502);
    expect(failing.headers['Cache-Control']).toBe('no-store');

    mocks.fetch.mockImplementation(async () => { throw new Error('The operation was aborted due to timeout'); });
    const timedOut = await request('record', { platform: 'bandcamp', release: 'any-day-now' });
    expect(timedOut.statusCode).toBe(502);
    expect(timedOut.headers['Cache-Control']).toBe('no-store');
  });

  it('a 404 from the image host is a definite answer, cached briefly', async () => {
    mocks.fetch.mockImplementation(async () => imageResponse(Buffer.from(''), 404));
    const res = await request('photo');
    expect(res.statusCode).toBe(404);
    expect(res.headers['Netlify-CDN-Cache-Control']).toBe('public, s-maxage=300');
  });
});
