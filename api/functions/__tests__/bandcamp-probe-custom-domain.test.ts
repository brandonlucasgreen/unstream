// Accounts behind a Bandcamp Pro custom domain. For a server-side request,
// zoekeating.bandcamp.com/music redirects to music.zoekeating.com/music and that redirects
// straight back, forever; the probe used to give up as "undecided", uncached, so Zoë Keating
// was missing from search whenever MusicBrainz didn't hand over her Bandcamp. The probe now
// stops at the first hop off Bandcamp and reads /community and /sitemap.xml, which don't loop.
//
// Fixtures are the real responses of 2026-10-26, trimmed to the parts read.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBandcampProbe: vi.fn(),
  putBandcampProbe: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../db', () => ({
  getBandcampProbe: mocks.getBandcampProbe,
  putBandcampProbe: mocks.putBandcampProbe,
}));
vi.mock('../ratelimit', () => ({ checkSentryDedup: vi.fn().mockResolvedValue(true) }));
vi.mock('../../lib/sentry', () => ({ withSentry: (handler: unknown) => handler, Sentry: { captureMessage: mocks.captureMessage } }));

import { findBandcampArtist } from '../../search/bandcamp-probe';
import { parseBandcampCommunityName, parseBandcampPageLocation, parseBandcampSitemap } from '../search-parsers';

const COMMUNITY = `<meta property="og:title" content="Zoe Keating&#39;s Community">
    <meta property="og:image" content="https://f4.bcbits.com/img/0013313374_23.jpg">
    <h3 class="location">Burlington, Vermont</h3>`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://zoekeating.bandcamp.com</loc></url>
    <url><loc>https://zoekeating.bandcamp.com/community</loc></url>
    <url><loc>https://zoekeating.bandcamp.com/album/into-the-trees</loc></url>
    <url><loc>https://zoekeating.bandcamp.com/album/the-edge-of-all-we-know-original-soundtrack</loc></url>
    <url><loc>https://zoekeating.bandcamp.com/track/possible</loc></url>
</urlset>`;

const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });

describe('the probe and accounts behind a custom domain', () => {
  const fetchMock = vi.fn();
  let routes: Record<string, () => Response>;

  beforeEach(() => {
    mocks.getBandcampProbe.mockReset().mockResolvedValue(null);
    mocks.putBandcampProbe.mockReset();
    mocks.captureMessage.mockReset();
    routes = {
      'https://zoekeating.bandcamp.com/music': () => redirect('https://music.zoekeating.com/music'),
      'https://music.zoekeating.com/music': () => redirect('https://zoekeating.bandcamp.com/music', 303),
      'https://zoekeating.bandcamp.com/community': () => new Response(COMMUNITY, { status: 200 }),
      'https://zoekeating.bandcamp.com/sitemap.xml': () => new Response(SITEMAP, { status: 200 }),
    };
    fetchMock.mockReset().mockImplementation(async (url: string) => (routes[url] ?? (() => new Response('', { status: 404 })))());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const requested = () => fetchMock.mock.calls.map(([url]) => url as string);

  it('finds the artist through /community and the sitemap instead of looping', async () => {
    const match = await findBandcampArtist('Zoe Keating');

    expect(match).toEqual({
      url: 'https://zoekeating.bandcamp.com',
      bandName: 'Zoe Keating',
      location: 'Burlington, Vermont',
      releaseTitles: ['intothetrees', 'theedgeofallweknoworiginalsoundtrack'],
      imageUrl: 'https://f4.bcbits.com/img/0013313374_23.jpg',
      bio: '',
    });
    expect(requested()).not.toContain('https://music.zoekeating.com/music');
    expect(requested().filter(url => url.endsWith('/music'))).toHaveLength(1);
    expect(mocks.putBandcampProbe).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'accepted',
      custom_domain: 'music.zoekeating.com',
      band_id: null,
      album_count: 2,
      track_count: 1,
      bio: '',
    }));
  });

  it('still checks the name, and caches a stranger as rejected', async () => {
    routes['https://zoekeating.bandcamp.com/community'] = () =>
      new Response(`<meta property="og:title" content="Somebody Else&#39;s Community">`, { status: 200 });

    expect(await findBandcampArtist('Zoe Keating')).toBeNull();
    expect(mocks.putBandcampProbe).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'rejected_name', band_name: 'Somebody Else' }));
  });

  it('does not cache a miss when /community is not there, and reports it', async () => {
    delete routes['https://zoekeating.bandcamp.com/community'];

    expect(await findBandcampArtist('Zoe Keating')).toBeNull();
    expect(mocks.putBandcampProbe).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith('Bandcamp custom-domain account could not be read', expect.anything());
  });

  it('does not read a sitemap it cannot parse as "no releases"', async () => {
    routes['https://zoekeating.bandcamp.com/sitemap.xml'] = () => new Response('<html>Maintenance</html>', { status: 200 });

    expect(await findBandcampArtist('Zoe Keating')).toBeNull();
    expect(mocks.putBandcampProbe).not.toHaveBeenCalled();
  });

  it('keeps following a redirect to another Bandcamp subdomain', async () => {
    routes['https://zoekeating.bandcamp.com/music'] = () => redirect('https://zoekeatingmusic.bandcamp.com/music');
    routes['https://zoekeatingmusic.bandcamp.com/music'] = () => new Response(
      `<div data-band="{&quot;id&quot;:7,&quot;name&quot;:&quot;Zoe Keating&quot;}"></div>
       <li class="music-grid-item" data-item-id="album-1"><p class="title">Into the Trees</p></li>`,
      { status: 200 },
    );

    const match = await findBandcampArtist('Zoe Keating');

    expect(match?.bandName).toBe('Zoe Keating');
    expect(mocks.putBandcampProbe).toHaveBeenCalledWith(expect.not.objectContaining({ custom_domain: expect.anything() }));
  });
});

describe('custom-domain page parsers', () => {
  it('reads the name from either possessive form of the community title', () => {
    expect(parseBandcampCommunityName(COMMUNITY)).toBe('Zoe Keating');
    // GET sufjanstevens.bandcamp.com/community, 2026-10-26.
    expect(parseBandcampCommunityName('<meta property="og:title" content="Sufjan Stevens&#39; Community">')).toBe('Sufjan Stevens');
    expect(parseBandcampCommunityName('<meta property="og:title" content="Music | Zoe Keating">')).toBeNull();
  });

  it('counts sitemap releases and titles albums the way the /music grid does', () => {
    expect(parseBandcampSitemap(SITEMAP)).toEqual({
      albums: 2,
      tracks: 1,
      releaseTitles: ['intothetrees', 'theedgeofallweknoworiginalsoundtrack'],
    });
  });

  it('reads the location from the community page heading', () => {
    expect(parseBandcampPageLocation(COMMUNITY)).toBe('Burlington, Vermont');
  });
});
