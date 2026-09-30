// Rows cached before bios were read have bio NULL, and accepted rows never expire — so
// without a one-time re-probe the most-searched artists would never get a Bandcamp bio.
// The re-probe must never cost an artist the Bandcamp link they already had.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBandcampProbe: vi.fn(),
  putBandcampProbe: vi.fn(),
}));

vi.mock('../db', () => ({
  getBandcampProbe: mocks.getBandcampProbe,
  putBandcampProbe: mocks.putBandcampProbe,
}));
vi.mock('../ratelimit', () => ({ checkSentryDedup: vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn() } }));

import { findBandcampArtist } from '../../search/bandcamp-probe';

const LEGACY_ROW = {
  query_norm: 'kidlightbulbs',
  artist_url: 'https://kidlightbulbs.bandcamp.com',
  band_name: 'Kid Lightbulbs',
  band_id: 1,
  album_count: 3,
  track_count: 0,
  matched_slug: 'kidlightbulbs',
  verdict: 'accepted',
  location: 'Brooklyn, New York',
  release_titles: ['anelectricheart'],
  image_url: null,
  bio: null,
  probed_slugs: ['kidlightbulbs'],
  checked_at: '2026-08-01T00:00:00Z',
};

const PAGE = `<div data-band="{&quot;id&quot;:1,&quot;name&quot;:&quot;Kid Lightbulbs&quot;}"></div>
<li class="music-grid-item" data-item-id="album-1"><p class="title">An Electric Heart</p></li>
<p id="bio-text">Experimental rock from Brooklyn.</p>`;

describe('findBandcampArtist and legacy rows without a bio', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    mocks.getBandcampProbe.mockReset();
    mocks.putBandcampProbe.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('re-probes once and stores the bio', async () => {
    mocks.getBandcampProbe.mockResolvedValue(LEGACY_ROW);
    fetchMock.mockResolvedValue(new Response(PAGE, { status: 200 }));

    const match = await findBandcampArtist('Kid Lightbulbs');

    expect(match?.bio).toBe('Experimental rock from Brooklyn.');
    expect(mocks.putBandcampProbe).toHaveBeenCalledWith(expect.objectContaining({ bio: 'Experimental rock from Brooklyn.' }));
  });

  it('keeps the cached link when the re-probe cannot answer', async () => {
    mocks.getBandcampProbe.mockResolvedValue(LEGACY_ROW);
    fetchMock.mockRejectedValue(new Error('timeout'));

    const match = await findBandcampArtist('Kid Lightbulbs');

    expect(match?.url).toBe('https://kidlightbulbs.bandcamp.com');
    expect(mocks.putBandcampProbe).not.toHaveBeenCalled();
  });

  it("does not re-probe a row that was checked and had no bio ('')", async () => {
    mocks.getBandcampProbe.mockResolvedValue({ ...LEGACY_ROW, bio: '' });

    const match = await findBandcampArtist('Kid Lightbulbs');

    expect(match?.bio).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
