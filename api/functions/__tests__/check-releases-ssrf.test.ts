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
  lookup: vi.fn(),
}));

// DNS is mocked so the suite is hermetic and so we can express the case that motivated
// resolution-time checks at all: a hostname that looks public and resolves private.
vi.mock('dns/promises', () => ({ lookup: mocks.lookup }));

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
import { isPrivateIpAddress, isSafePublicHostname, isUrlHostnameAllowed } from '../middleware';

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
  // Default: everything resolves to an ordinary public address.
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
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

describe('isPrivateIpAddress', () => {
  it.each([
    ['169.254.169.254', 'AWS/Azure/GCP metadata'],
    ['127.0.0.1', 'loopback'],
    ['127.99.99.99', 'loopback range'],
    ['10.1.2.3', 'private class A'],
    ['172.16.0.1', 'private class B'],
    ['172.31.255.255', 'private class B upper bound'],
    ['192.168.1.1', 'private class C'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback, dotted'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex groups (how Node normalizes it)'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata address'],
    ['not-an-address', 'unparseable'],
    ['', 'empty'],
  ])('treats %s as private (%s)', addr => {
    expect(isPrivateIpAddress(addr)).toBe(true);
  });

  it.each([
    ['93.184.216.34'],
    ['1.1.1.1'],
    ['172.15.0.1'],   // just below the private class B range
    ['172.32.0.1'],   // just above it
    ['100.63.0.1'],   // just below CGNAT
    ['100.128.0.1'],  // just above CGNAT
    ['2606:4700::1111'],
    ['::ffff:93.184.216.34'],
  ])('treats %s as public', addr => {
    expect(isPrivateIpAddress(addr)).toBe(false);
  });
});

describe('resolution-time checks', () => {
  // The gap that string checks could never close, and the reason the docstring on
  // isSafePublicHostname now says so explicitly: a name that is textually ordinary and
  // resolves to the metadata address. Wildcard DNS services hand these out for free.
  it('refuses a public hostname that resolves to the metadata address', async () => {
    mocks.isStoredArtistLink.mockResolvedValue(true);
    mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const r = await post({
      artistName: 'Someone',
      platforms: { faircamp: 'https://169-254-169-254.nip.io/feed.rss' },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).release).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // The exact path the review flagged: input is allowlisted, so no stored link is needed —
  // a Bandcamp Pro custom domain the attacker controls DNS for does the rest.
  it('refuses a redirect to a host that resolves into private space', async () => {
    mocks.lookup.mockImplementation(async (host: string) =>
      host === 'someone.bandcamp.com'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }]
    );
    mocks.fetch.mockResolvedValueOnce(res(301, { location: 'https://evil.example.com/music' }));

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).release).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // the redirect was never followed
  });

  it('refuses a dual-stack host smuggling a private AAAA behind a public A', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::1', family: 6 },
    ]);

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(JSON.parse(r.body).release).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses when resolution fails rather than assuming the target is fine', async () => {
    mocks.lookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses when resolution returns nothing', async () => {
    mocks.lookup.mockResolvedValue([]);

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows an ordinary public host', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.fetch.mockResolvedValue(res(200, { body: '<html></html>' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch).toHaveBeenCalled();
  });

  it('checks each hop, not just the first', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: 'https://music.sufjan.com/music' }))
      .mockResolvedValue(res(200, { body: '<html></html>', url: 'https://music.sufjan.com/music' }));

    await post({ artistName: 'Sufjan Stevens', platforms: { bandcamp: 'https://sufjanstevens.bandcamp.com' } });

    const resolved = mocks.lookup.mock.calls.map(c => c[0]);
    expect(resolved).toContain('sufjanstevens.bandcamp.com');
    expect(resolved).toContain('music.sufjan.com');
  });
});

describe('second-hop album link is confined to the host we landed on', () => {
  // safeFetch asks "is this target safe to fetch", not "is it allowlisted or stored for this
  // artist" the way mayFetch does for the entry URL. So without a host check, any absolute
  // href appearing in fetched markup becomes a URL this endpoint will request — a narrower
  // trust boundary than the entry point's, and a residual "fetch an arbitrary third-party
  // URL on our behalf" primitive even though internal targets stay blocked.
  const gridWith = (href: string) =>
    `<html><body><li class="music-grid-item"><a href="${href}"><p class="title">A Release</p></a></li></body></html>`;

  it('follows a root-relative album link, which is what Bandcamp actually emits', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        res(200, { body: gridWith('/album/real-release'), url: 'https://someone.bandcamp.com/music' })
      )
      .mockResolvedValue(res(200, { body: '"datePublished": "30 May 2025 00:00:00 GMT"' }));

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(String(mocks.fetch.mock.calls[1][0])).toBe('https://someone.bandcamp.com/album/real-release');
  });

  it('refuses an absolute cross-host album link embedded in the fetched page', async () => {
    mocks.fetch.mockResolvedValueOnce(
      res(200, {
        body: gridWith('https://attacker.example.com/expensive-endpoint'),
        url: 'https://someone.bandcamp.com/music',
      })
    );

    const r = await post({
      artistName: 'Someone',
      platforms: { bandcamp: 'https://someone.bandcamp.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).release).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // second hop never issued
  });

  it('refuses a protocol-relative cross-host link', async () => {
    mocks.fetch.mockResolvedValueOnce(
      res(200, { body: gridWith('//attacker.example.com/x'), url: 'https://someone.bandcamp.com/music' })
    );

    await post({ artistName: 'Someone', platforms: { bandcamp: 'https://someone.bandcamp.com' } });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  // The case the host check has to keep working: after a Bandcamp Pro custom-domain
  // redirect, same-origin means the custom domain, not *.bandcamp.com.
  it('allows a same-host link on a custom domain reached via redirect', async () => {
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: 'https://music.sufjan.com/music' }))
      .mockResolvedValueOnce(
        res(200, { body: gridWith('/album/javelin'), url: 'https://music.sufjan.com/music' })
      )
      .mockResolvedValue(res(200, { body: '"datePublished": "30 May 2025 00:00:00 GMT"' }));

    await post({ artistName: 'Sufjan Stevens', platforms: { bandcamp: 'https://sufjanstevens.bandcamp.com' } });

    expect(String(mocks.fetch.mock.calls[2][0])).toBe('https://music.sufjan.com/album/javelin');
  });

  it('refuses a link back to bandcamp.com once we have landed on a custom domain', async () => {
    // Same-host, not same-platform: after the redirect the trusted origin is the custom
    // domain, so a link elsewhere is out of scope even if it looks like Bandcamp.
    mocks.fetch
      .mockResolvedValueOnce(res(301, { location: 'https://music.sufjan.com/music' }))
      .mockResolvedValueOnce(
        res(200, {
          body: gridWith('https://someoneelse.bandcamp.com/album/x'),
          url: 'https://music.sufjan.com/music',
        })
      );

    await post({ artistName: 'Sufjan Stevens', platforms: { bandcamp: 'https://sufjanstevens.bandcamp.com' } });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
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
