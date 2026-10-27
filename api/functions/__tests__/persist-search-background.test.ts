// Search no longer waits on Supabase: it hands its results to persist-search-results-background
// and responds (request-persist.ts). What must hold:
//
//   - The background function is closed to everyone without INTERNAL_FUNCTION_SECRET. It writes
//     rows that become public artist pages.
//   - A dispatch that doesn't land costs latency, never data: every failure persists inline, and
//     says so (a warning, deduped) rather than quietly putting search back on the slow path.
//   - Only what persistSearchResults reads crosses the wire, so the body stays far under the
//     256 KB a background invocation accepts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistSearchResults: vi.fn(async () => {}),
  checkSentryDedup: vi.fn(async () => true),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../db', () => ({ persistSearchResults: mocks.persistSearchResults }));
vi.mock('../ratelimit', () => ({ checkSentryDedup: mocks.checkSentryDedup }));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.captureMessage, captureException: mocks.captureException },
  withSentry: <T>(fn: T) => fn,
}));

import { handler } from '../persist-search-results-background';
import {
  MAX_PERSIST_PAYLOAD_BYTES,
  parsePersistPayload,
  requestSearchPersist,
  toPersistPayload,
} from '../request-persist';
import { internalFunctionOrigin } from '../../lib/internal-origin';

const SECRET = 'test-secret-value';
const originalEnv = { ...process.env };

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    type: 'artist' as const,
    name: 'Big Thief',
    imageUrl: 'https://img/1.jpg',
    matchConfidence: 'verified',
    bio: { text: 'A band from Brooklyn.' },
    platforms: [{
      sourceId: 'bandcamp',
      url: 'https://bigthief.bandcamp.com',
      displayName: 'Big Thief',
      latestRelease: { title: 'Double Infinity', type: 'album', url: 'https://bigthief.bandcamp.com/album/x' },
      allReleaseTitles: ['double infinity', 'dragon new warm mountain'],
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_FUNCTION_SECRET = SECRET;
  process.env.URL = 'https://unstream.stream';
  process.env.SITE_NAME = 'unstream';
  mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('persist-search-results-background', () => {
  const post = (headers: Record<string, string | undefined>, body: unknown) =>
    handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });

  it('rejects a request without the secret, and writes nothing', async () => {
    expect((await post({}, { results: [card()] })).statusCode).toBe(401);
    expect((await post({ authorization: 'Bearer wrong-value-x' }, { results: [card()] })).statusCode).toBe(401);
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
  });

  // Fail closed: no configured secret closes the endpoint rather than opening it.
  it('rejects everything when no secret is configured', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    expect((await post({ authorization: 'Bearer anything' }, { results: [card()] })).statusCode).toBe(401);
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
  });

  it('rejects non-POST and a body that is not a payload', async () => {
    expect((await handler({ httpMethod: 'GET', headers: {} })).statusCode).toBe(405);
    expect((await handler({ httpMethod: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: '{nope' })).statusCode).toBe(400);
    expect((await post({ authorization: `Bearer ${SECRET}` }, { artists: [] })).statusCode).toBe(400);
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
  });

  it('persists the results it is sent', async () => {
    const response = await post({ authorization: `Bearer ${SECRET}` }, { results: toPersistPayload([card()] as never) });

    expect(response.statusCode).toBe(200);
    expect(mocks.persistSearchResults).toHaveBeenCalledWith([{
      type: 'artist',
      name: 'Big Thief',
      imageUrl: 'https://img/1.jpg',
      matchConfidence: 'verified',
      platforms: [{
        sourceId: 'bandcamp',
        url: 'https://bigthief.bandcamp.com',
        latestRelease: { title: 'Double Infinity', type: 'album', url: 'https://bigthief.bandcamp.com/album/x' },
      }],
    }]);
  });
});

describe('parsePersistPayload', () => {
  it('drops anything not shaped like an artist result', () => {
    const parsed = parsePersistPayload({
      results: [
        null,
        { type: 'album', name: 'An Album', platforms: [] },
        { type: 'artist', name: 42, platforms: [] },
        { type: 'artist', name: 'Ok', platforms: [{ sourceId: 'bandcamp' }, { sourceId: 'mirlo', url: 'https://mirlo.space/ok' }] },
      ],
    });
    expect(parsed).toEqual([{
      type: 'artist',
      name: 'Ok',
      imageUrl: undefined,
      matchConfidence: undefined,
      platforms: [{ sourceId: 'mirlo', url: 'https://mirlo.space/ok', latestRelease: undefined }],
    }]);
  });

  it("carries search's slug decision (null included) and the location through", () => {
    const [kept, none] = parsePersistPayload({
      results: [
        { type: 'artist', name: 'Paracosm', platforms: [], slug: 'paracosm-orlando', location: { city: 'Orlando', countryCode: 'US' } },
        { type: 'artist', name: 'Paracosm', platforms: [], slug: null, location: { city: 42 } },
      ],
    })!;
    expect(kept).toMatchObject({ slug: 'paracosm-orlando', location: { city: 'Orlando', countryCode: 'US' } });
    expect(none.slug).toBeNull();
    expect(none.location).toBeUndefined();
  });

  it('returns null when the body carries no results list', () => {
    expect(parsePersistPayload({})).toBeNull();
    expect(parsePersistPayload(null)).toBeNull();
  });
});

describe('requestSearchPersist', () => {
  it('posts only what persistence reads to the background function, with the secret', async () => {
    const mode = await requestSearchPersist([card(), card({ id: 'r2', type: 'album', name: 'An Album' })] as never);

    expect(mode).toBe('background');
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://unstream.netlify.app/.netlify/functions/persist-search-results-background');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    const sent = JSON.parse(init.body).results;
    expect(sent).toHaveLength(1); // the album card stays behind
    expect(sent[0]).not.toHaveProperty('bio');
    expect(sent[0]).not.toHaveProperty('id');
    expect(sent[0].platforms[0]).not.toHaveProperty('allReleaseTitles');
    expect(sent[0].platforms[0]).not.toHaveProperty('displayName');
  });

  it('does nothing when there is no artist to persist', async () => {
    expect(await requestSearchPersist([card({ type: 'track' })] as never)).toBe('none');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.persistSearchResults).not.toHaveBeenCalled();
  });

  // A bot challenge answers 403 without throwing — the failure request-catalog can't see.
  it.each([
    ['a bot challenge', () => mocks.fetch.mockResolvedValue(new Response('Just a moment...', { status: 403 }))],
    ['a network error', () => mocks.fetch.mockRejectedValue(new Error('connect ECONNREFUSED'))],
  ])('persists inline and reports it after %s', async (_label, arrange) => {
    arrange();

    const mode = await requestSearchPersist([card()] as never);

    expect(mode).toBe('inline-dispatch-failed');
    expect(mocks.persistSearchResults).toHaveBeenCalledTimes(1);
    expect(mocks.checkSentryDedup).toHaveBeenCalledWith('persist-dispatch-failed', 3600);
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a recurring failure once per window, not once per search', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 500 }));
    mocks.checkSentryDedup.mockResolvedValueOnce(true).mockResolvedValue(false);

    await requestSearchPersist([card()] as never);
    await requestSearchPersist([card()] as never);

    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(mocks.persistSearchResults).toHaveBeenCalledTimes(2);
  });

  it('persists inline instead of sending a payload too big for a background invocation', async () => {
    const huge = card({
      platforms: [{ sourceId: 'bandcamp', url: `https://x.bandcamp.com/${'a'.repeat(MAX_PERSIST_PAYLOAD_BYTES)}` }],
    });

    const mode = await requestSearchPersist([huge] as never);

    expect(mode).toBe('inline-oversize');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.persistSearchResults).toHaveBeenCalledTimes(1);
    expect(mocks.checkSentryDedup).toHaveBeenCalledWith('persist-dispatch-oversize', 3600);
  });

  it('persists inline, unreported, where the secret is not configured', async () => {
    delete process.env.INTERNAL_FUNCTION_SECRET;

    expect(await requestSearchPersist([card()] as never)).toBe('inline-unconfigured');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.persistSearchResults).toHaveBeenCalledTimes(1);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('never throws at the search', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 500 }));
    mocks.persistSearchResults.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(requestSearchPersist([card()] as never)).resolves.toBe('error');
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  // A realistic search: a dozen artist cards, each with eight platforms and a latest release.
  // Measured to keep the 256 KB background limit an abstraction rather than a risk.
  it('keeps a realistic search far under the payload limit', () => {
    const platforms = Array.from({ length: 8 }, (_, i) => ({
      sourceId: `platform-${i}`,
      url: `https://artist-name-${i}.example.com/some/fairly/long/path/to/the/artist`,
      latestRelease: {
        title: 'A Reasonably Long Album Title (Deluxe Edition)',
        type: 'album',
        url: `https://artist-name-${i}.example.com/album/a-reasonably-long-album-title-deluxe-edition`,
        imageUrl: 'https://f4.bcbits.com/img/a1234567890_16.jpg',
        releaseDate: '2026-10-01',
      },
      allReleaseTitles: Array.from({ length: 40 }, (_, t) => `release title number ${t}`),
    }));
    const results = Array.from({ length: 12 }, (_, i) => card({ id: `r${i}`, name: `Artist ${i}`, platforms }));

    const bytes = Buffer.byteLength(JSON.stringify({ results: toPersistPayload(results as never) }));

    expect(bytes).toBeLessThan(MAX_PERSIST_PAYLOAD_BYTES / 4);
  });
});

describe('internalFunctionOrigin', () => {
  it("uses the site's netlify.app host, outside Cloudflare, in production", () => {
    expect(internalFunctionOrigin()).toBe('https://unstream.netlify.app');
  });

  it('uses localhost as is under netlify dev', () => {
    process.env.URL = 'http://localhost:8888';
    expect(internalFunctionOrigin()).toBe('http://localhost:8888');
  });

  it('falls back to URL without a usable site name', () => {
    delete process.env.SITE_NAME;
    expect(internalFunctionOrigin()).toBe('https://unstream.stream');
    process.env.SITE_NAME = 'not a hostname/../';
    expect(internalFunctionOrigin()).toBe('https://unstream.stream');
  });
});
