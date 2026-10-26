import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({ getClient: () => null }));

import { purgeCacheTags } from '../purge-cache';

const saved = {
  NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID,
  SITE_ID: process.env.SITE_ID,
  NETLIFY_API_TOKEN: process.env.NETLIFY_API_TOKEN,
};

function clearCredentials() {
  for (const key of Object.keys(saved)) delete process.env[key];
}

function setNetlifyCredentials() {
  process.env.NETLIFY_SITE_ID = 'site123';
  process.env.NETLIFY_API_TOKEN = 'token';
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
  it('purges Netlify by tag when its credentials are set', async () => {
    setNetlifyCredentials();

    await purgeCacheTags(['artist-mono', 'artist-releases-mono'], 'Test');

    expect(urlsCalled()).toEqual(['https://api.netlify.com/api/v1/purge']);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ site_id: 'site123', cache_tags: ['artist-mono', 'artist-releases-mono'] });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('does nothing, loudly, when it is not configured', async () => {
    await purgeCacheTags(['artist-mono'], 'Test');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no CDN purge credentials set'));
  });

  it('reports a refused purge instead of counting it as done', async () => {
    // A purge that was refused looks exactly like a purge that worked, and the symptom — an
    // artist's edit not showing for an hour — gets blamed on the edit.
    setNetlifyCredentials();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));

    await purgeCacheTags(['artist-mono'], 'Test');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    expect(console.log).not.toHaveBeenCalled();
  });

  it('never throws at the caller when a purge fails outright', async () => {
    setNetlifyCredentials();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    // The write this purge follows has already succeeded; stale-for-the-TTL beats failing an
    // artist's edit over cache hygiene.
    await expect(purgeCacheTags(['artist-mono'], 'Test')).resolves.toBeUndefined();
  });

  it('makes no call at all for an empty tag list', async () => {
    setNetlifyCredentials();

    await purgeCacheTags([], 'Test');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the purge host is on the outbound allowlist', () => {
  /**
   * The URL is a constant, so it has no host anything could redirect. It is checked anyway
   * because every other constant-URL fetch in this backend does (dispatch-feed.ts, stripe.ts), and
   * because the allowlist is meant to be the inventory of every host the backend talks to.
   */
  it('lists it, so the inventory is complete', async () => {
    const { ALLOWED_OUTBOUND_HOSTNAMES } = await import('../middleware');

    expect(ALLOWED_OUTBOUND_HOSTNAMES.has('api.netlify.com')).toBe(true);
  });

  it('refuses to purge a host the allowlist does not cover', async () => {
    setNetlifyCredentials();

    const middleware = await import('../middleware');
    const spy = vi.spyOn(middleware, 'isUrlHostnameAllowed').mockReturnValue(false);
    try {
      await purgeCacheTags(['artist-mono'], 'Test');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not on the outbound allowlist'));
    } finally {
      spy.mockRestore();
    }
  });
});
