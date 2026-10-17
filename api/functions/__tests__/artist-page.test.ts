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
  checkSentryDedup: vi.fn(),
  captureMessage: vi.fn(),
  isPublishedArtistSlug: vi.fn(),
  resolveArtistSlugAlias: vi.fn(),
  getTipsLiveSlugs: vi.fn(),
  getGoals: vi.fn(),
  // The flag store, read the way the real one reads it: a Map standing in for the
  // `feature-flags` hash. Empty means every flag is off, which is what production starts at
  // (UNS-215), so a test that wants tips has to switch the flag on.
  flagStore: new Map<string, unknown>(),
  hgetall: vi.fn(),
}));

vi.mock('../tips-db', () => ({
  getTipsLiveSlugs: mocks.getTipsLiveSlugs,
  getGoals: mocks.getGoals,
}));

// Redis is always stubbed rather than reached (see cache-should-cache.test.ts: the Netlify build
// carries production Upstash credentials). This stub also drives the real feature-flags module,
// so the gate under test is the shipping one, not a mock of it.
vi.mock('../redis', () => ({
  getRedis: () => ({ hgetall: (key: string) => mocks.hgetall(key) }),
  reportRedisFailure: vi.fn(),
}));


vi.mock('../db', () => ({
  getArtistProfileBySlug: mocks.getArtistProfileBySlug,
  getArtistReleases: mocks.getArtistReleases,
  getClient: () => ({}),
  resolveArtistSlugAlias: mocks.resolveArtistSlugAlias,
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkSentryDedup: mocks.checkSentryDedup,
  getClientIp: () => '203.0.113.1',
}));

// Mocked so these tests assert on what the endpoint *decides to report*, independent of whether a
// DSN is configured. Whether the events then leave the process is the deployment's problem —
// which is exactly how 77 call sites managed to report nothing for weeks without a test noticing.
vi.mock('../../lib/sentry', () => ({
  withSentry: (handler: unknown) => handler,
  Sentry: { captureMessage: mocks.captureMessage },
}));

// The real module reads data/artists-manifest.json; published-artist-slugs.test.ts covers that.
vi.mock('../../shared/published-artist-slugs', () => ({
  isPublishedArtistSlug: mocks.isPublishedArtistSlug,
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
    // reset, not clear: the alias tests queue two `mockResolvedValueOnce` values, and
    // clearAllMocks leaves an unconsumed one queued to leak into the next test.
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getArtistReleases.mockResolvedValue({ releases: [], total: 0 });
    mocks.checkSentryDedup.mockResolvedValue(true);
    mocks.isPublishedArtistSlug.mockReturnValue(false);
    mocks.resolveArtistSlugAlias.mockResolvedValue({ canonical: null, failed: false });
    mocks.getTipsLiveSlugs.mockResolvedValue(new Set());
    mocks.getGoals.mockResolvedValue([]);
    mocks.flagStore.clear();
    mocks.hgetall.mockImplementation(async (key: string) =>
      key === 'feature-flags' ? Object.fromEntries(mocks.flagStore) : null);
  });

  it('returns 200 with links for an unclaimed artist', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });

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

  describe('page sections (UNS-221)', () => {
    const sectionLinks = [
      { platform: 'bandcamp', url: 'https://funkadelic.bandcamp.com', display_name: null },
      { platform: 'patreon', url: 'https://www.patreon.com/funkadelic', display_name: null },
      { platform: 'instagram', url: 'https://www.instagram.com/funkadelic', display_name: null },
      { platform: 'faircamp', url: 'https://funkadelic.faircamp.site', display_name: null },
      { platform: 'newsletter', url: 'https://buttondown.email/funkadelic', display_name: null },
    ];
    const claimedRow = artistRow({ match_confidence: 'claimed' });
    const claimedProfile = {
      bio: 'Free your mind.',
      custom_image_url: null,
      featured_embed: null,
      verified_at: '2026-06-01T00:00:00.000Z',
      link_dividers: null,
    };

    it('groups links into sections with official last (faircamp + newsletter recategorized)', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({
        failed: false,
        bundle: { artist: claimedRow, profile: claimedProfile, links: sectionLinks },
      });

      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.linkGroups.map((g: { section: string }) => g.section)).toEqual([
        'patronage',
        'marketplaces',
        'social',
        'official',
      ]);
      const official = body.linkGroups.find((g: { section: string }) => g.section === 'official');
      expect(official.links.map((l: { platform: string }) => l.platform)).toEqual(['faircamp', 'newsletter']);
      const social = body.linkGroups.find((g: { section: string }) => g.section === 'social');
      expect(social.links.map((l: { platform: string }) => l.platform)).toEqual(['instagram']);
    });

    it('resolves the artist section-order into the payload', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({
        failed: false,
        bundle: {
          artist: claimedRow,
          profile: { ...claimedProfile, section_order: ['bio', 'featured', 'social', 'marketplaces', 'patronage'] },
          links: sectionLinks,
        },
      });

      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.sectionOrder).toEqual(['bio', 'featured', 'social', 'marketplaces', 'patronage']);
    });

    it('sectionOrder defaults when nothing is stored, and legacy fields stay consistent', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({
        failed: false,
        bundle: { artist: claimedRow, profile: { ...claimedProfile, section_order: null }, links: sectionLinks },
      });

      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.sectionOrder).toEqual(['bio', 'featured', 'patronage', 'marketplaces', 'social']);
      // Legacy flat fields still render the same links for pre-UNS-221 clients (the Mac app):
      // every sectioned link appears in `links`.
      expect(body.links).toHaveLength(5);
      expect(body.socialLinks.map((l: { platform: string }) => l.platform)).toEqual(['instagram']);
    });

    it('an unknown platform id rides in marketplaces, never dropped', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({
        failed: false,
        bundle: {
          artist: claimedRow,
          profile: claimedProfile,
          links: [...sectionLinks, { platform: 'something_new', url: 'https://example.com', display_name: 'New Thing' }],
        },
      });

      const body = JSON.parse((await call('funkadelic')).body);
      const marketplaces = body.linkGroups.find((g: { section: string }) => g.section === 'marketplaces');
      expect(marketplaces.links.map((l: { platform: string }) => l.platform)).toContain('something_new');
      expect(body.links).toHaveLength(6);
    });
  });

  it('reports a verified claimed artist as claimed', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({ failed: false, bundle: {
      artist: artistRow({ match_confidence: 'claimed' }),
      profile: {
        bio: 'Free your mind.',
        custom_image_url: 'https://example.com/custom.jpg',
        featured_embed: null,
        verified_at: '2026-06-01T00:00:00.000Z',
        link_dividers: null,
      },
      links,
    } });

    const body = JSON.parse((await call('funkadelic')).body);
    expect(body.profile.verifiedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(body.artist.imageUrl).toBe('https://example.com/custom.jpg');
  });

  it('does not treat a profile row on an unclaimed artist as claimed', async () => {
    // Mid-claim state: the profile row exists but the artist was never marked claimed. The edge
    // function shows crawlers the quiet card here, so the SPA has to as well.
    mocks.getArtistProfileBySlug.mockResolvedValue({ failed: false, bundle: {
      artist: artistRow({ match_confidence: 'verified' }),
      profile: {
        bio: null,
        custom_image_url: 'https://example.com/custom.jpg',
        featured_embed: null,
        verified_at: '2026-06-01T00:00:00.000Z',
        link_dividers: null,
      },
      links,
    } });

    const body = JSON.parse((await call('funkadelic')).body);
    expect(body.profile.verifiedAt).toBeNull();
    expect(body.artist.imageUrl).toBe('https://f4.bcbits.com/img/0026457743_23.jpg');
  });

  it('404s when there is no artist row for the slug', async () => {
    mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });

    const res = await call('not-a-real-artist');
    expect(res.statusCode).toBe(404);
  });

  it('400s without a slug', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: {}, headers: {} });
    expect(res.statusCode).toBe(400);
  });

  // --- the 404 signal (UNS: Funkadelic follow-up) ---

  describe('reporting', () => {
    it('reports a 404 on a slug we publish', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });
      mocks.isPublishedArtistSlug.mockReturnValue(true);

      expect((await call('funkadelic')).statusCode).toBe(404);
      expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
      const [message, opts] = mocks.captureMessage.mock.calls[0];
      expect(message).toContain('published artist slug');
      expect(opts.tags.slug).toBe('funkadelic');
    });

    it('stays quiet on a 404 for a slug we never published', async () => {
      // The whole point of gating on the manifest: crawlers and typos must not drown the signal.
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });
      mocks.isPublishedArtistSlug.mockReturnValue(false);

      expect((await call('asdfasdf')).statusCode).toBe(404);
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });

    it('reports a published-slug 404 only once per dedup window', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });
      mocks.isPublishedArtistSlug.mockReturnValue(true);
      mocks.checkSentryDedup.mockResolvedValue(false); // already reported this hour

      expect((await call('funkadelic')).statusCode).toBe(404);
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });

    it('503s and reports when the lookup itself fails, rather than 404ing', async () => {
      // The distinction that matters: a database outage must not render as "artist not found" on
      // every page. A 404 here would be a monitoring signal that actively lies.
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: true });

      const res = await call('funkadelic');
      expect(res.statusCode).toBe(503);
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
      expect(mocks.captureMessage.mock.calls[0][1].level).toBe('error');
    });

    it('does not fire the published-slug 404 signal when the lookup failed', async () => {
      // failed=true must take the 503 branch even for a published slug, so an outage reports as an
      // outage rather than as ~790 "we publish a broken URL" warnings.
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: true });
      mocks.isPublishedArtistSlug.mockReturnValue(true);

      expect((await call('funkadelic')).statusCode).toBe(503);
      expect(mocks.captureMessage.mock.calls[0][0]).toContain('lookup failed');
    });
  });

  describe('release rows carry a price line the client cannot compute', () => {
    beforeEach(() => {
      // The outer beforeEach doesn't stub the artist lookup — each test supplies its own — so
      // without this every call here 404s and the assertions read `undefined`.
      mocks.getArtistProfileBySlug.mockResolvedValue({
        bundle: { artist: artistRow(), profile: null, links },
        failed: false,
      });
    });

    // The Mac app and the extension have no copy of the payout registry and must not grow one —
    // that hand-copied-figure drift is what let the Discord bot quote an unsourced Jam.coop rate
    // for months. So the summary is priced here, exactly as `check-releases` does for an alert.
    const sources = [
      {
        platform: 'bandcamp',
        offers: [{ price: 8, currency: 'USD', availability: 'available' }],
      },
      {
        platform: 'discogs',
        offers: [{ price: 2.64, currency: 'USD', availability: 'available' }],
      },
    ];

    const release = {
      slug: 'maggot-brain',
      title: 'Maggot Brain',
      releaseType: 'album',
      releaseDate: '1971-07-12',
      datePrecision: 'day',
      status: 'released',
      artworkUrl: null,
      sources,
    };

    it('prices the leading artist-paying source, not the cheapest listing', async () => {
      mocks.getArtistReleases.mockResolvedValue({ releases: [release], total: 1 });

      const body = JSON.parse((await call('funkadelic')).body);

      // Discogs is cheaper at $2.64 and must NOT win: it is a secondhand marketplace, so the
      // artist receives nothing. Bandcamp leads on payout, so its price is the one quoted.
      expect(body.releases[0].offerSummary).toBe('from $8 · ≈$6.40–$6.80 to artist');
      expect(body.releases[0].platforms).toEqual(['bandcamp', 'discogs']);
    });

    it('says nothing rather than inventing a price when no source has a buyable offer', async () => {
      mocks.getArtistReleases.mockResolvedValue({
        releases: [{ ...release, sources: [{ platform: 'bandcamp', offers: [] }] }],
        total: 1,
      });

      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.releases[0].offerSummary).toBe('');
    });

    it('keeps every field the release already had', async () => {
      mocks.getArtistReleases.mockResolvedValue({ releases: [release], total: 1 });

      const body = JSON.parse((await call('funkadelic')).body);
      // Additive only — the SPA artist page reads these and must not lose them.
      expect(body.releases[0]).toMatchObject({
        slug: 'maggot-brain',
        title: 'Maggot Brain',
        releaseDate: '1971-07-12',
        datePrecision: 'day',
        status: 'released',
      });
    });

    it('reports the true total when the 60-release cap truncates the list', async () => {
      // The client shows "Showing 60 of 84" off this; collapsing them would imply the list is
      // the whole catalogue.
      mocks.getArtistReleases.mockResolvedValue({ releases: [release], total: 84 });

      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.releaseCount).toBe(84);
      expect(body.releases).toHaveLength(1);
    });
  });

  // The accent-folding fix (#410) re-slugged five artists we publish and aliased their old slugs.
  // Every other URL-serving surface learned to resolve those; this endpoint — the one the SPA
  // renders from — did not, so `/a/trentem-ller` showed a human the not-found card for 26 days
  // while crawlers got a clean 301 and `/a/trentemoller` worked fine.
  describe('retired slugs', () => {
    it('serves the canonical artist when the requested slug is an alias', async () => {
      mocks.getArtistProfileBySlug
        .mockResolvedValueOnce({ bundle: null, failed: false })
        .mockResolvedValueOnce({
          bundle: { artist: artistRow({ slug: 'trentemoller', name: 'Trentemøller' }), profile: null, links: [] },
          failed: false,
        });
      mocks.resolveArtistSlugAlias.mockResolvedValue({ canonical: 'trentemoller', failed: false });

      const res = await call('trentem-ller');

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).artist.slug).toBe('trentemoller');
      expect(mocks.resolveArtistSlugAlias).toHaveBeenCalledWith('trentem-ller');
    });

    it('tags the cached response with the canonical slug, so one purge clears both URLs', async () => {
      mocks.getArtistProfileBySlug
        .mockResolvedValueOnce({ bundle: null, failed: false })
        .mockResolvedValueOnce({
          bundle: { artist: artistRow({ slug: 'trentemoller' }), profile: null, links: [] },
          failed: false,
        });
      mocks.resolveArtistSlugAlias.mockResolvedValue({ canonical: 'trentemoller', failed: false });

      const res = await call('trentem-ller');

      expect(res.headers['Cache-Tag']).toBe('artist-page-trentemoller');
    });

    it('does not pay for an alias lookup when the slug resolves', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });

      await call('funkadelic');

      expect(mocks.resolveArtistSlugAlias).not.toHaveBeenCalled();
    });

    // An outage is not evidence that a slug was retired, and the 503 has to survive.
    it('does not look for an alias after a failed lookup', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: true });

      const res = await call('trentem-ller');

      expect(res.statusCode).toBe(503);
      expect(mocks.resolveArtistSlugAlias).not.toHaveBeenCalled();
    });

    // An alias lookup that broke is an outage too, not evidence the slug is gone — it must
    // surface as the same 503 as any other lookup failure, never a 404 that looks like the truth.
    it('returns the 503 when the alias lookup itself fails', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });
      mocks.resolveArtistSlugAlias.mockResolvedValue({ canonical: null, failed: true });

      const res = await call('trentem-ller');

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('Artist lookup temporarily unavailable');
    });

    it('still 404s when the slug is neither an artist nor an alias', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: null, failed: false });

      const res = await call('not-an-artist');

      expect(res.statusCode).toBe(404);
    });
  });

  describe('tips', () => {
    // Inner hooks run after the outer beforeEach that clears the store, so this survives.
    beforeEach(() => {
      // Tips reach a fan only while the fan-facing flag says so (UNS-215), so a test about tips
      // reaching a fan has to switch tipsFans on first. tipsArtists is irrelevant here: this is
      // the page a fan reads, not the artist's own dashboard.
      mocks.flagStore.set('tipsFans', 'on');
    });

    it('says the artist is taking tips, with their open goals', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      mocks.getTipsLiveSlugs.mockResolvedValue(new Set(['funkadelic']));
      mocks.getGoals.mockResolvedValue([{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 500, status: 'open' }]);
      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.tips).toEqual({ enabled: true, goals: [expect.objectContaining({ title: 'Vinyl', raisedCents: 500 })] });
    });

    it('shows no goals and no Tip for an artist not taking tips', async () => {
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      const body = JSON.parse((await call('funkadelic')).body);
      expect(body.tips).toEqual({ enabled: false, goals: [] });
      expect(mocks.getGoals).not.toHaveBeenCalled();
    });

    // --- the UNS-215 gate ---

    it('hides the Tip and every goal while the flag is off, without reading them', async () => {
      // Flag off is the pre-rollout state: this artist's data says they ARE taking tips, and
      // the payload still says otherwise. The read is skipped, so nothing can leak through it.
      mocks.flagStore.set('tipsFans', 'off');
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      mocks.getTipsLiveSlugs.mockResolvedValue(new Set(['funkadelic']));
      mocks.getGoals.mockResolvedValue([{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 500, status: 'open' }]);

      const body = JSON.parse((await call('funkadelic')).body);

      expect(body.tips).toEqual({ enabled: false, goals: [] });
      expect(mocks.getTipsLiveSlugs).not.toHaveBeenCalled();
      expect(mocks.getGoals).not.toHaveBeenCalled();
    });

    it('hides tips when the flag store itself cannot be read', async () => {
      // Fail closed: a Redis outage must not be the reason a flag-off feature goes live.
      mocks.flagStore.set('tipsFans', 'on');
      mocks.hgetall.mockRejectedValue(new Error('ECONNRESET'));
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      mocks.getTipsLiveSlugs.mockResolvedValue(new Set(['funkadelic']));

      const body = JSON.parse((await call('funkadelic')).body);

      expect(body.tips).toEqual({ enabled: false, goals: [] });
      expect(mocks.getTipsLiveSlugs).not.toHaveBeenCalled();
    });

    it('hides tips while the flag is missing from the hash', async () => {
      // Same as off, and the state every flag starts in.
      mocks.flagStore.clear();
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      mocks.getTipsLiveSlugs.mockResolvedValue(new Set(['funkadelic']));

      const body = JSON.parse((await call('funkadelic')).body);

      expect(body.tips).toEqual({ enabled: false, goals: [] });
      expect(mocks.getTipsLiveSlugs).not.toHaveBeenCalled();
    });

    it('still hides tips when only the artist-side flag is on', async () => {
      // The split's whole point: letting artists register with Stripe does not put a Tip button
      // in front of a fan. tipsArtists is on here, tipsFans is not.
      mocks.flagStore.set('tipsFans', 'off');
      mocks.flagStore.set('tipsArtists', 'on');
      mocks.getArtistProfileBySlug.mockResolvedValue({ bundle: { artist: artistRow(), profile: null, links }, failed: false });
      mocks.getTipsLiveSlugs.mockResolvedValue(new Set(['funkadelic']));

      expect(JSON.parse((await call('funkadelic')).body).tips).toEqual({ enabled: false, goals: [] });
      expect(mocks.getTipsLiveSlugs).not.toHaveBeenCalled();
    });
  });
});
