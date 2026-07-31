// check-releases was an unauthenticated, unvalidated, unmetered outbound fetcher: it took
// URLs from the request body, fetched them, then followed a link found *inside* the fetched
// page, and reflected parsed fields back to the caller.
//
// The non-obvious half of the fix is that validating the URL we were *given* says nothing
// about the URL we actually *retrieve* — Node's fetch follows redirects transparently, and
// Bandcamp Pro artists really do redirect off *.bandcamp.com onto custom domains
// (sufjanstevens.bandcamp.com -> music.sufjan.com). So every hop has to be re-validated.
// These tests pin that down, plus the rate-limit tier that keeps shipped clients working.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '1.2.3.4'),
  isStoredArtistLink: vi.fn(),
  fetch: vi.fn(),
}));

// Rate limiting and the DB are the two side-effecting dependencies. Redis is never touched
// because checkRateLimit itself is mocked — CI has real Upstash credentials, so a test that
// reached the real limiter would talk to production.
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));

vi.mock('../db', () => ({
  isStoredArtistLink: mocks.isStoredArtistLink,
}));

import { handler } from '../check-releases';
import { isSafePublicHostname, isUrlHostnameAllowed } from '../middleware';

function post(body: unknown) {
  return handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

/** A minimal Response stand-in; only what safeFetch and the parsers read. */
function res(
  status: number,
  opts: { body?: string; location?: string; url?: string } = {}
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: opts.url ?? '',
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? opts.location ?? null : null) },
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.isStoredArtistLink.mockResolvedValue(false);
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('isSafePublicHostname', () => {
  // These are the targets that make an SSRF bug serious rather than merely rude.
  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'AWS metadata'],
    ['http://metadata.google.internal/', 'GCP metadata'],
    ['http://100.100.100.200/', 'Alibaba metadata'],
    ['http://127.0.0.1:8080/', 'loopback'],
    ['http://127.1.2.3/', 'loopback range beyond 127.0.0.1'],
    ['http://10.0.0.5/', 'private class A'],
    ['http://172.16.0.1/', 'private class B'],
    ['http://192.168.1.1/', 'private class C'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback'],
    ['http://2130706433/', 'decimal-encoded loopback'],
    ['http://0177.0.0.1/', 'octal-encoded loopback'],
    ['http://buildserver.local/', 'mDNS .local'],
    ['http://vault.internal/', '.internal namespace'],
    ['file:///etc/passwd', 'non-HTTP scheme'],
    ['gopher://example.com/', 'non-HTTP scheme'],
  ])('rejects %s (%s)', url => {
    expect(isSafePublicHostname(url)).toBe(false);
  });

  it('accepts ordinary public hosts, including ones off the allowlist', () => {
    expect(isSafePublicHostname('https://sufjanstevens.bandcamp.com/music')).toBe(true);
    // The whole point of splitting this out: a Bandcamp custom domain is a legitimate
    // redirect target even though no allowlist entry covers it.
    expect(isSafePublicHostname('https://music.sufjan.com/music')).toBe(true);
    expect(isSafePublicHostname('https://music.someartist.com/feed.rss')).toBe(true);
  });
});

describe('isUrlHostnameAllowed still gates on the allowlist', () => {
  it('admits allowlisted hosts and rejects arbitrary public ones', () => {
    expect(isUrlHostnameAllowed('https://artist.bandcamp.com/music')).toBe(true);
    expect(isUrlHostnameAllowed('https://mirlo.space/foo')).toBe(true);
    expect(isUrlHostnameAllowed('https://artist.faircamp.net/')).toBe(true);
    expect(isUrlHostnameAllowed('https://music.sufjan.com/music')).toBe(false);
    expect(isUrlHostnameAllowed('https://evil.example.com/')).toBe(false);
  });

  it('cannot be talked into an unsafe target by an allowlisted-looking name', () => {
    // "faircamp" as a non-leftmost label normally passes; a private address must not.
    expect(isUrlHostnameAllowed('http://10.0.0.1/')).toBe(false);
    expect(isUrlHostnameAllowed('file://bandcamp.com/etc/passwd')).toBe(false);
  });
});

describe('handler input validation', () => {
  it('refuses a metadata address supplied as a platform URL', async () => {
    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'http://169.254.169.254/latest/meta-data/' },
    });

    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/no platform url could be verified/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary public URL that we have never stored', async () => {
    const r = await post({
      artistName: 'Someone',
      platforms: { faircamp: 'https://victim.example.com/expensive-endpoint' },
    });

    expect(r.statusCode).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows a self-hosted Faircamp domain that is already stored for the artist', async () => {
    // The reason a bare allowlist is the wrong tool here: real Faircamp lives on arbitrary
    // domains, so "have we already discovered this link for this artist?" is the check.
    mocks.isStoredArtistLink.mockResolvedValue(true);
    mocks.fetch.mockResolvedValue(res(200, { body: '<rss></rss>' }));

    const r = await post({
      artistName: 'Someone',
      platforms: { faircamp: 'https://music.someartist.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(mocks.isStoredArtistLink).toHaveBeenCalledWith('https://music.someartist.com', 'Someone');
    expect(mocks.fetch).toHaveBeenCalled();
  });

  it('does not consult the database for an allowlisted host', async () => {
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.isStoredArtistLink).not.toHaveBeenCalled();
  });

  it('still checks the platforms it can verify when another is refused', async () => {
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    const r = await post({
      artistName: 'Someone',
      platforms: {
        bandcamp: 'https://someone.bandcamp.com',
        faircamp: 'http://192.168.0.10/',
      },
    });

    expect(r.statusCode).toBe(200);
    const fetched = mocks.fetch.mock.calls.map(c => String(c[0]));
    expect(fetched.some(u => u.includes('someone.bandcamp.com'))).toBe(true);
    expect(fetched.some(u => u.includes('192.168.0.10'))).toBe(false);
  });
});

describe('redirect handling', () => {
  it('follows a Bandcamp custom-domain redirect', async () => {
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: 'https://music.sufjan.com/music' }))
      .mockResolvedValue(res(200, { body: '<html></html>', url: 'https://music.sufjan.com/music' }));

    const r = await post({
      artistName: 'Sufjan Stevens',
      platforms: { bandcamp: 'https://sufjanstevens.bandcamp.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(String(mocks.fetch.mock.calls[1][0])).toBe('https://music.sufjan.com/music');
  });

  it('does NOT follow a redirect to an internal address', async () => {
    // The bypass this whole change exists to close: input passes the allowlist, then the
    // server hands us a Location pointing at cloud metadata.
    mocks.fetch.mockResolvedValueOnce(
      res(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    );

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).release).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // never followed
  });

  it('refuses a relative redirect that resolves onto an internal host', async () => {
    mocks.fetch.mockResolvedValueOnce(res(302, { location: '//169.254.169.254/meta' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    mocks.fetch.mockResolvedValue(res(302, { location: 'https://someone.bandcamp.com/music' }));

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(r.statusCode).toBe(200);
    // MAX_REDIRECTS is 5, so 6 attempts at most — bounded, not unbounded.
    expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('passes redirect: manual so hops cannot be followed behind our back', async () => {
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('rate limiting', () => {
  it('uses the lenient tier, because clients loop once per saved artist', async () => {
    // A strict (10/min) tier would silently break release alerts for every artist past the
    // tenth in both the Mac app and the extension, which swallow the error and move on.
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith('1.2.3.4', 'lenient', expect.anything());
  });

  it('returns the limiter response and fetches nothing when limited', async () => {
    const limited = { statusCode: 429, headers: {}, body: '{"error":"rate limited"}' };
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: limited });

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(r).toBe(limited);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('backward compatibility with shipped clients', () => {
  // The Mac app (3.3.x) and extension (2.5.x) are already released against this contract.
  it('keeps the response shape', async () => {
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    const parsed = JSON.parse(r.body);
    expect(Object.keys(parsed).sort()).toEqual(['artistName', 'release']);
    expect(parsed.artistName).toBe('Someone');
  });

  it('still rejects a request with no platform URLs', async () => {
    const r = await post({ artistName: 'Someone', platforms: {} });
    expect(r.statusCode).toBe(400);
  });

  it('still rejects a non-POST method', async () => {
    const r = await handler({ httpMethod: 'GET', headers: {} });
    expect(r.statusCode).toBe(405);
  });

  it('answers the CORS preflight with a wildcard origin for native clients', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(r.statusCode).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
