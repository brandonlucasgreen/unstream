// The feed endpoint: routing, and the privacy properties of the token path.
//
// The security-relevant assertions here are the ones about what the response *doesn't* do —
// a token must never be cacheable by a shared cache, an unknown token must be indistinguishable
// from a malformed one, and a handle that hasn't opted into sharing must 404 exactly like a
// handle that doesn't exist (otherwise the feed enumerates who has an account).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '1.2.3.4'),
  getFeedTokenOwner: vi.fn(),
  getFeedReleasesForUser: vi.fn(),
  getFeedReleasesForArtist: vi.fn(),
  getFeedReleasesForHandle: vi.fn(),
  resolveArtistSlugAlias: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));
vi.mock('../db', () => ({
  getFeedTokenOwner: mocks.getFeedTokenOwner,
  getFeedReleasesForUser: mocks.getFeedReleasesForUser,
  getFeedReleasesForArtist: mocks.getFeedReleasesForArtist,
  getFeedReleasesForHandle: mocks.getFeedReleasesForHandle,
  resolveArtistSlugAlias: mocks.resolveArtistSlugAlias,
}));

import { handler, parsePath, requestPath } from '../feed-releases';

const TOKEN = 'kZ8vQ2mN4pR7sT1wY6bE3hJ9lX0cA5dF8gK2nP4qS7u';

function row(over: Record<string, unknown> = {}) {
  return {
    artistName: 'Kid Lightbulbs',
    artistSlug: 'kid-lightbulbs',
    title: 'Infinite Normal',
    releaseSlug: 'infinite-normal',
    releaseDate: '2026-09-01',
    offerSummary: '',
    platforms: [],
    artworkUrl: null,
    sources: [{ platform: 'bandcamp', url: 'https://x.bandcamp.com/album/a-record', offers: [{ price: 8, currency: 'USD', availability: 'available' }] }],
    ...over,
  };
}

/**
 * ICS content lines are folded at 75 octets, so a raw `toContain` against the body fails
 * whenever the string it's looking for straddles a fold. Unfold first, the way a real parser
 * does, and assert against the logical content.
 */
function unfoldIcs(body: string): string {
  return body.replace(/\r\n /g, '');
}

function get(path: string) {
  return handler({
    httpMethod: 'GET',
    rawUrl: `https://unstream.stream${path}`,
    headers: { 'x-nf-client-connection-ip': '1.2.3.4' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.getFeedTokenOwner.mockResolvedValue(null);
  mocks.getFeedReleasesForUser.mockResolvedValue([]);
  mocks.getFeedReleasesForArtist.mockResolvedValue(null);
  mocks.getFeedReleasesForHandle.mockResolvedValue(null);
  mocks.resolveArtistSlugAlias.mockResolvedValue(null);
});

describe('requestPath', () => {
  // Every route reaches this function through a status-200 rewrite, and on a rewrite
  // `event.path` can be the rewrite target, which carries no routing information at all.
  it('prefers rawUrl over path, because a rewrite overwrites path', () => {
    expect(
      requestPath({ path: '/.netlify/functions/feed-releases', rawUrl: 'https://unstream.stream/feed/f/abc.ics' })
    ).toBe('/feed/f/abc.ics');
  });

  it('falls back to path when rawUrl is absent or unparseable', () => {
    expect(requestPath({ path: '/feed/f/abc.ics' })).toBe('/feed/f/abc.ics');
    expect(requestPath({ path: '/feed/f/abc.ics', rawUrl: 'not a url' })).toBe('/feed/f/abc.ics');
  });

  it('drops the query string', () => {
    expect(requestPath({ rawUrl: 'https://unstream.stream/feed/f/abc.ics?x=1' })).toBe('/feed/f/abc.ics');
  });
});

describe('parsePath', () => {
  it('recognises all three shapes in both formats', () => {
    expect(parsePath('/feed/f/abc.ics')).toEqual({ kind: 'token', token: 'abc', format: 'ics' });
    expect(parsePath('/feed/f/abc.xml')).toEqual({ kind: 'token', token: 'abc', format: 'xml' });
    expect(parsePath('/u/brandon/releases.ics')).toEqual({ kind: 'handle', handle: 'brandon', format: 'ics' });
    expect(parsePath('/a/kid-lightbulbs/releases.xml')).toEqual({
      kind: 'artist',
      slug: 'kid-lightbulbs',
      format: 'xml',
    });
  });

  it('rejects anything else', () => {
    expect(parsePath('/feed/f/abc.json')).toBeNull();
    expect(parsePath('/feed/f/a/b.ics')).toBeNull();
    expect(parsePath('/u/brandon')).toBeNull();
    expect(parsePath('/a/kid-lightbulbs/some-release')).toBeNull();
    expect(parsePath('/')).toBeNull();
  });
});

describe('the private token feed', () => {
  it('serves a calendar for a known token', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([row()]);

    const r = await get(`/feed/f/${TOKEN}.ics`);

    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
    expect(r.body).toContain('BEGIN:VCALENDAR');
    expect(r.body).toContain('Infinite Normal');
  });

  it('serves Atom for the same token', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([row()]);

    const r = await get(`/feed/f/${TOKEN}.xml`);

    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/atom+xml; charset=utf-8');
    expect(r.body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  });

  // A fan's subscription list must not sit in a CDN or any shared cache.
  it('marks the private feed no-store and noindex', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');

    const r = await get(`/feed/f/${TOKEN}.ics`);

    expect(r.headers['Cache-Control']).toBe('private, no-store');
    expect(r.headers['X-Robots-Tag']).toBe('noindex, nofollow');
  });

  // 404 rather than 401: a 401 invites retrying, and confirming "well-formed but unknown"
  // tells an anonymous caller more than they need.
  it('404s an unknown token, identically to a malformed one', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue(null);

    const unknown = await get(`/feed/f/${TOKEN}.ics`);
    const malformed = await get('/feed/f/short.ics');

    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.body).toBe(malformed.body);
  });

  // Shape-check first so a scan of junk paths costs no database work.
  it('does not query the database for a token that cannot be one', async () => {
    await get('/feed/f/../../etc/passwd.ics');
    await get('/feed/f/short.ics');

    expect(mocks.getFeedTokenOwner).not.toHaveBeenCalled();
  });

  it('serves an empty but valid calendar when nothing is coming up', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([]);

    const r = await get(`/feed/f/${TOKEN}.ics`);

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('BEGIN:VCALENDAR');
    expect(r.body).toContain('END:VCALENDAR');
    expect(r.body).not.toContain('BEGIN:VEVENT');
  });
});

describe('the public handle feed', () => {
  it('serves a shared list', async () => {
    mocks.getFeedReleasesForHandle.mockResolvedValue({ displayName: 'brandon', releases: [row()] });

    const r = await get('/u/brandon/releases.ics');

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("brandon's upcoming releases");
  });

  // Null covers both "no such handle" and "hasn't opted into sharing" — the same 404 either
  // way, so the feed can't enumerate which handles exist.
  it('404s a handle that has not opted into sharing', async () => {
    mocks.getFeedReleasesForHandle.mockResolvedValue(null);

    const r = await get('/u/private-person/releases.ics');

    expect(r.statusCode).toBe(404);
  });

  it('lets a public feed be cached, unlike the private one', async () => {
    mocks.getFeedReleasesForHandle.mockResolvedValue({ displayName: 'brandon', releases: [] });

    const r = await get('/u/brandon/releases.xml');

    expect(r.headers['Cache-Control']).toBe('public, max-age=1800');
  });
});

describe('the public artist feed', () => {
  it('serves one artist’s releases', async () => {
    mocks.getFeedReleasesForArtist.mockResolvedValue({ artistName: 'Kid Lightbulbs', releases: [row()] });

    const r = await get('/a/kid-lightbulbs/releases.xml');

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kid Lightbulbs — releases');
  });

  // An artist feed is a discography, not a calendar of what's imminent — the window belongs to
  // the per-fan feeds. Saying "upcoming" here would misdescribe a feed full of back catalogue.
  it('does not describe an artist feed as upcoming, in either format', async () => {
    mocks.getFeedReleasesForArtist.mockResolvedValue({ artistName: 'Kid Lightbulbs', releases: [row()] });

    const atom = await get('/a/kid-lightbulbs/releases.xml');
    const ics = await get('/a/kid-lightbulbs/releases.ics');

    expect(atom.body.toLowerCase()).not.toContain('upcoming');
    expect(ics.body.toLowerCase()).not.toContain('upcoming');
    // …and the calendar description names the artist rather than "the artists you support".
    expect(ics.body).toContain('Releases by Kid Lightbulbs');
  });

  it('404s an unknown artist', async () => {
    const r = await get('/a/nobody/releases.xml');
    expect(r.statusCode).toBe(404);
  });

  // A calendar client keeps fetching whatever URL it was handed and never reports a 404 to
  // anybody, so an artist re-slugged after somebody subscribed would silently lose them.
  it('resolves a retired artist slug through the alias table', async () => {
    mocks.getFeedReleasesForArtist.mockImplementation(async (slug: string) =>
      slug === 'beyonce' ? { artistName: 'Beyoncé', releases: [row()] } : null
    );
    mocks.resolveArtistSlugAlias.mockResolvedValue('beyonce');

    const r = await get('/a/beyonc/releases.xml');

    expect(r.statusCode).toBe(200);
    expect(mocks.resolveArtistSlugAlias).toHaveBeenCalledWith('beyonc');
    // Self-link and feed id both canonical: the link should point at the address that still
    // works, and one id per artist keeps a reslug from splitting subscribers across two feeds.
    expect(r.body).toContain('/a/beyonce/releases.xml');
    expect(r.body).toContain('tag:unstream.stream,2026:feed/a/beyonce');
    expect(r.body).not.toContain('beyonc/releases.xml');
  });

  it('never reads the alias table when the live slug answers', async () => {
    mocks.getFeedReleasesForArtist.mockResolvedValue({ artistName: 'Kid Lightbulbs', releases: [row()] });

    const r = await get('/a/kid-lightbulbs/releases.xml');

    expect(r.statusCode).toBe(200);
    expect(mocks.resolveArtistSlugAlias).not.toHaveBeenCalled();
    expect(mocks.getFeedReleasesForArtist).toHaveBeenCalledTimes(1);
  });

  it('404s when the slug is neither live nor an alias', async () => {
    mocks.resolveArtistSlugAlias.mockResolvedValue(null);

    const r = await get('/a/nobody/releases.ics');

    expect(r.statusCode).toBe(404);
    expect(mocks.getFeedReleasesForArtist).toHaveBeenCalledTimes(1);
  });
});

describe('platform naming and ordering', () => {
  // Registry names, not raw ids: "Jam.coop", never "jamcoop".
  it('uses proper platform names in the event description', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([
      row({ sources: [{ platform: 'jamcoop', url: 'https://jam.coop/artists/x/albums/a', offers: [] }] }),
    ]);

    const r = await get(`/feed/f/${TOKEN}.ics`);

    expect(unfoldIcs(r.body)).toContain('Jam.coop');
    expect(unfoldIcs(r.body)).not.toContain('jamcoop:');
  });

  // The same artist-paying-first guardrail as the release page and the alerts: a secondhand
  // Discogs listing must never be named ahead of a direct Bandcamp purchase.
  it('names the artist-paying platform first', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([
      row({
        sources: [
          { platform: 'discogs', url: 'https://discogs.com/release/1', offers: [{ price: 2.64, currency: 'USD', availability: 'available' }] },
          { platform: 'bandcamp', url: 'https://x.bandcamp.com/album/a-record', offers: [{ price: 8, currency: 'USD', availability: 'available' }] },
        ],
      }),
    ]);

    const r = await get(`/feed/f/${TOKEN}.ics`);

    // One line per platform now, so "first" means the earlier line — Bandcamp (80-85%) ahead of
    // Discogs (no published payout), never the other way round.
    const body = unfoldIcs(r.body);
    expect(body.indexOf('Bandcamp:')).toBeGreaterThan(-1);
    expect(body.indexOf('Bandcamp:')).toBeLessThan(body.indexOf('Discogs:'));
  });

  it('gives every platform a reachable link, not just a name', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');
    mocks.getFeedReleasesForUser.mockResolvedValue([row()]);

    const ics = await get(`/feed/f/${TOKEN}.ics`);
    const atom = await get(`/feed/f/${TOKEN}.xml`);

    expect(unfoldIcs(ics.body)).toContain('Bandcamp: https://x.bandcamp.com/album/a-record');
    expect(atom.body).toContain('href="https://x.bandcamp.com/album/a-record"');
  });
});

describe('method and rate limiting', () => {
  it('allows HEAD, which some calendar clients probe with', async () => {
    mocks.getFeedTokenOwner.mockResolvedValue('user-1');

    const r = await handler({
      httpMethod: 'HEAD',
      rawUrl: `https://unstream.stream/feed/f/${TOKEN}.ics`,
      headers: {},
    });

    expect(r.statusCode).toBe(200);
  });

  it('rejects a write method', async () => {
    const r = await handler({ httpMethod: 'POST', rawUrl: `https://unstream.stream/feed/f/${TOKEN}.ics`, headers: {} });
    expect(r.statusCode).toBe(405);
  });

  it('returns the limiter response when limited', async () => {
    const limited = { statusCode: 429, headers: {}, body: 'slow down' };
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: limited });

    const r = await get(`/feed/f/${TOKEN}.ics`);

    expect(r).toBe(limited);
    expect(mocks.getFeedTokenOwner).not.toHaveBeenCalled();
  });
});
