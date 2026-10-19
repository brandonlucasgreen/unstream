import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({ getClient: () => null }));

import { purgeCacheTags } from '../purge-cache';

/**
 * Both CDNs are purged while both can be serving: Netlify is production until the cutover and
 * stays up for two weeks afterwards as the rollback path. A purge that reached only one of them
 * would leave stale pages on the other, and the rollback is exactly the moment nobody is
 * watching for that.
 */
const saved = {
  NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID,
  SITE_ID: process.env.SITE_ID,
  NETLIFY_API_TOKEN: process.env.NETLIFY_API_TOKEN,
  CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
  CLOUDFLARE_PURGE_TOKEN: process.env.CLOUDFLARE_PURGE_TOKEN,
};

function clearCredentials() {
  for (const key of Object.keys(saved)) delete process.env[key];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearCredentials();
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCredentials();
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
});

function urlsCalled(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('purgeCacheTags', () => {
  it('purges Cloudflare by tag when its credentials are set', async () => {
    process.env.CLOUDFLARE_ZONE_ID = 'zone123';
    process.env.CLOUDFLARE_PURGE_TOKEN = 'token';

    await purgeCacheTags(['artist-mono', 'artist-releases-mono'], 'Test');

    expect(urlsCalled()).toEqual(['https://api.cloudflare.com/client/v4/zones/zone123/purge_cache']);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ tags: ['artist-mono', 'artist-releases-mono'] });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('purges Netlify when its credentials are set', async () => {
    process.env.NETLIFY_SITE_ID = 'site123';
    process.env.NETLIFY_API_TOKEN = 'token';

    await purgeCacheTags(['artist-mono'], 'Test');

    expect(urlsCalled()).toEqual(['https://api.netlify.com/api/v1/purge']);
  });

  it('purges both when both are configured, which is the cutover window', async () => {
    process.env.NETLIFY_SITE_ID = 'site123';
    process.env.NETLIFY_API_TOKEN = 'token';
    process.env.CLOUDFLARE_ZONE_ID = 'zone123';
    process.env.CLOUDFLARE_PURGE_TOKEN = 'cf-token';

    await purgeCacheTags(['artist-mono'], 'Test');

    expect(urlsCalled().sort()).toEqual([
      'https://api.cloudflare.com/client/v4/zones/zone123/purge_cache',
      'https://api.netlify.com/api/v1/purge',
    ]);
  });

  it('does nothing, loudly, when neither is configured', async () => {
    await purgeCacheTags(['artist-mono'], 'Test');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no CDN purge credentials set'));
  });

  it('reports a throttled Cloudflare purge instead of counting it as done', async () => {
    // A purge being rate-limited looks exactly like a purge that worked, and the symptom — an
    // artist's edit not showing for an hour — gets blamed on the edit.
    process.env.CLOUDFLARE_ZONE_ID = 'zone123';
    process.env.CLOUDFLARE_PURGE_TOKEN = 'token';
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    await purgeCacheTags(['artist-mono'], 'Test');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    expect(console.log).not.toHaveBeenCalled();
  });

  it('never throws at the caller when a purge fails outright', async () => {
    process.env.CLOUDFLARE_ZONE_ID = 'zone123';
    process.env.CLOUDFLARE_PURGE_TOKEN = 'token';
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    // The write this purge follows has already succeeded; stale-for-the-TTL beats failing an
    // artist's edit over cache hygiene.
    await expect(purgeCacheTags(['artist-mono'], 'Test')).resolves.toBeUndefined();
  });

  it('makes no call at all for an empty tag list', async () => {
    process.env.CLOUDFLARE_ZONE_ID = 'zone123';
    process.env.CLOUDFLARE_PURGE_TOKEN = 'token';

    await purgeCacheTags([], 'Test');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
