// GET /api/artist-page — the JSON the React artist page renders from.
//
// The thing worth locking: an *unclaimed* artist gets a 200 with their links. This endpoint
// shipped for claimed profiles only, and once #369 made real browsers render /artist/:slug from
// the SPA instead of the static edge HTML, that filter turned into a 404 on every one of the ~790
// unclaimed artist pages — while crawlers, which the edge function still serves, saw a fine page.
// Restore the `match_confidence === 'claimed'` gate anywhere in this path and the first test here
// fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getArtistProfileBySlug: vi.fn(),
  getArtistReleases: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('../db', () => ({
  getArtistProfileBySlug: mocks.getArtistProfileBySlug,
  getArtistReleases: mocks.getArtistReleases,
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => '203.0.113.1',
}));

import { handler } from '../artist-page';

const artistRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'artist-1',
  slug: 'funkadelic',
  name: 'Funkadelic',
  image_url: 'https://f4.bcbits.com/img/0026457743_23.jpg',
  match_confidence: 'verified',
  country: null,
  country_code: null,
  city: null,
  ...overrides,
});

const links = [
  { platform: 'bandcamp', url: 'https://funkadelic.bandcamp.com', display_name: null },
  { platform: 'discogs', url: 'https://www.discogs.com/artist/29923', display_name: null },
  // Search-engine junk the page filters out.
  { platform: 'kofi', url: 'https://duckduckgo.com/?q=site:ko-fi.com+Funkadelic', display_name: null },
];

const call = (slug: string) => handler({ httpMethod: 'GET', queryStringParameters: { slug }, headers: {} });

describe('GET /api/artist-page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getArtistReleases.mockResolvedValue({ releases: [], total: 0 });
  });

  it('returns 200 with links for an unclaimed artist', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({ artist: artistRow(), profile: null, links });

    const res = await call('funkadelic');
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.artist.name).toBe('Funkadelic');
    expect(body.links.map((l: { url: string }) => l.url)).toEqual([
      'https://funkadelic.bandcamp.com',
      'https://www.discogs.com/artist/29923',
    ]);
    // No verifiedAt means the SPA renders UnclaimedQuietCard rather than the rich profile.
    expect(body.profile).toBeNull();
  });

  it('reports a verified claimed artist as claimed', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({
      artist: artistRow({ match_confidence: 'claimed' }),
      profile: {
        bio: 'Free your mind.',
        custom_image_url: 'https://example.com/custom.jpg',
        featured_embed: null,
        verified_at: '2026-06-01T00:00:00.000Z',
        link_dividers: null,
      },
      links,
    });

    const body = JSON.parse((await call('funkadelic')).body);
    expect(body.profile.verifiedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(body.artist.imageUrl).toBe('https://example.com/custom.jpg');
  });

  it('does not treat a profile row on an unclaimed artist as claimed', async () => {
    // Mid-claim state: the profile row exists but the artist was never marked claimed. The edge
    // function shows crawlers the quiet card here, so the SPA has to as well.
    mocks.getArtistProfileBySlug.mockResolvedValue({
      artist: artistRow({ match_confidence: 'verified' }),
      profile: {
        bio: null,
        custom_image_url: 'https://example.com/custom.jpg',
        featured_embed: null,
        verified_at: '2026-06-01T00:00:00.000Z',
        link_dividers: null,
      },
      links,
    });

    const body = JSON.parse((await call('funkadelic')).body);
    expect(body.profile.verifiedAt).toBeNull();
    expect(body.artist.imageUrl).toBe('https://f4.bcbits.com/img/0026457743_23.jpg');
  });

  it('404s when there is no artist row for the slug', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue(null);

    const res = await call('not-a-real-artist');
    expect(res.statusCode).toBe(404);
  });

  it('400s without a slug', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: {}, headers: {} });
    expect(res.statusCode).toBe(400);
  });
});
