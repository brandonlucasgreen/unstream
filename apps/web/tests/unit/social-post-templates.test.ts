import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The weekly social post copy lives in scripts/ because only the GitHub Action runs it, but it
// publishes on Unstream's behalf every day, so it's tested with the rest.
import {
  CHARACTER_LIMITS,
  bandcampMatchesArtist,
  featurePost,
  fullSizeImageUrl,
  indieSpotlight,
  isQuestionWeek,
  linkedinRoundup,
  linkedinWeekdayPost,
  makerPost,
  payoutFloor,
  pickCatalogueRelease,
  purchaseMath,
  questionPost,
  recordMath,
  type ArtistContext,
  type CatalogueRelease,
  type ShippedFeature,
  type SocialPost,
} from '../../../../scripts/social-post-templates';
import { PLATFORMS } from '../../../../api/shared/platform-registry';

const BANDCAMP_PAYOUT = PLATFORMS.bandcamp.payoutPercent!;

function artist(overrides: Partial<ArtistContext> = {}): ArtistContext {
  return {
    name: 'Courstellation',
    url: 'https://unstream.stream/a/courstellation',
    imageUrl: 'https://f4.bcbits.com/img/0042724752_23.jpg',
    location: 'Phoenix',
    threadsHandle: null,
    blueskyHandle: null,
    platform: {
      id: 'bandcamp',
      name: 'Bandcamp',
      payout: BANDCAMP_PAYOUT,
      release: { title: 'Signals', type: 'album', latest: true },
    },
    ...overrides,
  };
}

function on(posts: SocialPost[] | null, platform: SocialPost['platform']): SocialPost {
  const post = posts?.find(p => p.platform === platform);
  if (!post) throw new Error(`no ${platform} post`);
  return post;
}

function withinLimit(post: SocialPost) {
  expect(post.text.length).toBeLessThanOrEqual(CHARACTER_LIMITS[post.platform]);
}

describe('payout math', () => {
  it('reads the low end of a registry range', () => {
    expect(payoutFloor('80-85%')).toBe(0.8);
    expect(payoutFloor('~70%')).toBe(0.7);
    expect(payoutFloor('97%')).toBe(0.97);
    expect(payoutFloor('unknown')).toBeNull();
  });

  it('turns a payout into what a $10 album pays and the streams it equals', () => {
    expect(purchaseMath('80-85%')).toEqual({ take: '$8', streams: '2,700' });
    expect(purchaseMath('86-90%')).toEqual({ take: '$8.60', streams: '2,900' });
  });
});

describe('fullSizeImageUrl', () => {
  it('asks Bandcamp for the 1200px rendition', () => {
    expect(fullSizeImageUrl('https://f4.bcbits.com/img/0042724752_23.jpg')).toBe('https://f4.bcbits.com/img/0042724752_10.jpg');
    expect(fullSizeImageUrl('https://f4.bcbits.com/img/a0370958576_2.jpg')).toBe('https://f4.bcbits.com/img/a0370958576_10.jpg');
  });

  it('leaves other hosts alone', () => {
    const url = 'https://example.supabase.co/storage/v1/object/public/artist-images/x_23.jpg';
    expect(fullSizeImageUrl(url)).toBe(url);
  });
});

describe('bandcampMatchesArtist', () => {
  it("accepts the artist's own subdomain, give or take the/music/official/band", () => {
    expect(bandcampMatchesArtist('Death Cab for Cutie', 'https://deathcabforcutie.bandcamp.com')).toBe(true);
    expect(bandcampMatchesArtist('Melvins', 'https://melvinsofficial.bandcamp.com')).toBe(true);
    expect(bandcampMatchesArtist('The Lemonheads', 'https://thelemonheadsmusic.bandcamp.com')).toBe(true);
    expect(bandcampMatchesArtist('The National', 'https://thenational.bandcamp.com')).toBe(true);
    expect(bandcampMatchesArtist('Trentemøller', 'https://trentemoller.bandcamp.com')).toBe(true);
  });

  it("rejects another act's page filed under a famous name", () => {
    expect(bandcampMatchesArtist('Venom', 'https://venomnoise.bandcamp.com')).toBe(false);
    expect(bandcampMatchesArtist('EMPEROR', 'https://emperordnb.bandcamp.com')).toBe(false);
    expect(bandcampMatchesArtist('Alan Jackson', 'https://alanjackson1.bandcamp.com')).toBe(false);
  });

  it('rejects anything that is not a bare Bandcamp subdomain', () => {
    expect(bandcampMatchesArtist('Venom', 'https://bandcamp.com/search?q=venom')).toBe(false);
    expect(bandcampMatchesArtist('Venom', 'https://venom.bandcamp.com/album/x')).toBe(false);
  });

  // The generated files are where the bad links live, so check the two known ones there.
  it('rejects the mismatched links in the real artist files', () => {
    for (const slug of ['venom', 'emperor']) {
      const data = JSON.parse(readFileSync(join(__dirname, `../../../../data/artists/${slug}.json`), 'utf-8'));
      const artist = Array.isArray(data) ? data[0] : data;
      const link = artist.platforms.find((p: { sourceId: string }) => p.sourceId === 'bandcamp');
      expect(bandcampMatchesArtist(artist.name, link.url)).toBe(false);
    }
  });
});

describe('pickCatalogueRelease', () => {
  function release(overrides: Partial<CatalogueRelease> = {}): CatalogueRelease {
    return { title: 'Signals', releaseType: 'album', releaseDate: '2025-03-01', status: 'released', sources: [{ platform: 'bandcamp' }], ...overrides };
  }

  it('names the newest dated release on the platform as the latest', () => {
    const picked = pickCatalogueRelease([
      release({ title: 'Older', releaseDate: '2023-05-01' }),
      release({ title: 'Newest', releaseDate: '2026-02-14', releaseType: 'ep' }),
      release({ title: 'Undated', releaseDate: null }),
    ], 'bandcamp');
    expect(picked).toEqual({ title: 'Newest', type: 'ep', latest: true });
  });

  it("only considers releases on the platform the post sends people to", () => {
    const picked = pickCatalogueRelease([
      release({ title: 'Discogs Only', releaseDate: '2026-09-01', sources: [{ platform: 'discogs' }] }),
      release({ title: 'On Bandcamp', releaseDate: '2024-01-01' }),
    ], 'bandcamp');
    expect(picked?.title).toBe('On Bandcamp');
  });

  it('falls back to the first undated release in catalogue order, without calling it the latest', () => {
    const picked = pickCatalogueRelease([
      release({ title: 'First In Order', releaseDate: null }),
      release({ title: 'Second', releaseDate: null }),
    ], 'bandcamp');
    expect(picked).toEqual({ title: 'First In Order', type: 'album', latest: false });
  });

  it('skips announced releases, which are pre-orders rather than out', () => {
    const picked = pickCatalogueRelease([
      release({ title: 'Coming Soon', releaseDate: '2026-11-20', status: 'announced' }),
      release({ title: 'Out Now', releaseDate: '2026-01-10' }),
    ], 'bandcamp');
    expect(picked?.title).toBe('Out Now');
  });

  it('returns nothing when the platform has none of their releases', () => {
    expect(pickCatalogueRelease([], 'bandcamp')).toBeNull();
    expect(pickCatalogueRelease([release({ sources: [{ platform: 'mirlo' }] })], 'bandcamp')).toBeNull();
  });
});

describe('indieSpotlight', () => {
  it('names the release, the platform and the registry payout', () => {
    const threads = on(indieSpotlight(artist(), { bandcampFriday: false }), 'threads');
    expect(threads.text).toBe(
      `Today's artist: Courstellation, from Phoenix.\n\n` +
      `Their latest album, Signals, is on Bandcamp. Buy it there and ${BANDCAMP_PAYOUT} of what you pay goes to them.\n\n` +
      `Every place to support them directly: https://unstream.stream/a/courstellation`
    );
  });

  it("names a release without claiming it's the latest when nothing dates it", () => {
    const undated = artist({ platform: { id: 'bandcamp', name: 'Bandcamp', payout: BANDCAMP_PAYOUT, release: { title: 'Signals', type: 'album', latest: false } } });
    const threads = on(indieSpotlight(undated, { bandcampFriday: false }), 'threads');
    expect(threads.text).toContain('Their album Signals is on Bandcamp.');
    expect(threads.text).not.toContain('latest');
  });

  it('tags a Threads handle after the name, so a mention that fails still reads as a name', () => {
    const threads = on(indieSpotlight(artist({ threadsHandle: 'courstellation' }), { bandcampFriday: false }), 'threads');
    expect(threads.text).toContain('Courstellation (@courstellation)');
  });

  it('never tags on Threads without a Threads handle', () => {
    const threads = on(indieSpotlight(artist({ blueskyHandle: 'courstellation.bsky.social' }), { bandcampFriday: false }), 'threads');
    expect(threads.text).not.toContain('@');
  });

  it('says so on Bandcamp Friday, for Bandcamp artists only', () => {
    const bandcamp = on(indieSpotlight(artist(), { bandcampFriday: true }), 'threads');
    expect(bandcamp.text).toContain('today is Bandcamp Friday');
    expect(bandcamp.text).not.toContain(BANDCAMP_PAYOUT);

    const mirlo = artist({ platform: { id: 'mirlo', name: 'Mirlo', payout: '86-90%', release: null } });
    expect(on(indieSpotlight(mirlo, { bandcampFriday: true }), 'threads').text).not.toContain('Bandcamp Friday');
  });

  it('returns nothing for an artist with nowhere to buy their music', () => {
    expect(indieSpotlight(artist({ platform: null }), { bandcampFriday: false })).toBeNull();
  });

  it('leaves a WebP photo off Threads but keeps it on Bluesky', () => {
    const webp = artist({ imageUrl: 'https://cdn.mirlo.space/file/artist-avatars/abc-x600.webp' });
    const posts = indieSpotlight(webp, { bandcampFriday: false });
    expect(on(posts, 'threads').images).toEqual([]);
    expect(on(posts, 'bluesky').images).toHaveLength(1);
  });

  it('sends a full-size image with alt text', () => {
    const threads = on(indieSpotlight(artist(), { bandcampFriday: false }), 'threads');
    expect(threads.images).toEqual([{ url: 'https://f4.bcbits.com/img/0042724752_10.jpg', altText: 'Photo of Courstellation' }]);
  });

  it('fits Bluesky by dropping hashtags, then detail, before going over', () => {
    const long = artist({
      name: 'The Extremely Long Named Orchestra of Somewhere Far Away',
      blueskyHandle: 'extremelylongnamedorchestra.bsky.social',
      location: 'Llanfairpwllgwyngyll',
      platform: { id: 'bandcamp', name: 'Bandcamp', payout: BANDCAMP_PAYOUT, release: { title: 'A Title That Is Very Nearly Sixty Characters Long Indeed', type: 'album', latest: true } },
    });
    const bluesky = on(indieSpotlight(long, { bandcampFriday: false }), 'bluesky');
    withinLimit(bluesky);
    expect(bluesky.text).not.toContain('#musicsky');
  });
});

describe('recordMath', () => {
  const prominent = artist({
    name: 'Death Cab for Cutie',
    url: 'https://unstream.stream/artist/death-cab-for-cutie',
    location: null,
    platform: { id: 'bandcamp', name: 'Bandcamp', payout: BANDCAMP_PAYOUT, release: { title: 'I Built You A Tower', type: 'album', latest: true } },
  });

  it('frames one album purchase against streams, at the low end of the payout', () => {
    const threads = on(recordMath(prominent, { bandcampFridayTomorrow: false }), 'threads');
    expect(threads.text).toContain(`Buying I Built You A Tower on Bandcamp instead of streaming it: Death Cab for Cutie keeps ${BANDCAMP_PAYOUT} of what you pay.`);
    expect(threads.text).toContain("On a $10 album that's at least $8.");
    expect(threads.text).toContain('around 2,700 streams');
    withinLimit(on(recordMath(prominent, { bandcampFridayTomorrow: false }), 'bluesky'));
  });

  it('only names a release that is an album, since the math is per album', () => {
    const single = artist({ ...prominent, platform: { ...prominent.platform!, release: { title: 'A Single', type: 'single', latest: true } } });
    const threads = on(recordMath(single, { bandcampFridayTomorrow: false }), 'threads');
    expect(threads.text).not.toContain('A Single');
    expect(threads.text).toContain("Buying Death Cab for Cutie's music on Bandcamp");
  });

  it('becomes a Bandcamp Friday heads-up the day before', () => {
    const threads = on(recordMath(prominent, { bandcampFridayTomorrow: true }), 'threads');
    expect(threads.text).toMatch(/^Tomorrow is Bandcamp Friday\./);
  });

  it('returns nothing without a payout figure, because the post is the figure', () => {
    const noPayout = artist({ platform: { id: 'bandwagon', name: 'Bandwagon', payout: null, release: null } });
    expect(recordMath(noPayout, { bandcampFridayTomorrow: false })).toBeNull();
  });

  it('never tags the artist', () => {
    const tagged = artist({ ...prominent, threadsHandle: 'deathcab', blueskyHandle: 'deathcab.bsky.social' });
    for (const post of recordMath(tagged, { bandcampFridayTomorrow: false })!) expect(post.text).not.toContain('@');
  });
});

describe('questions', () => {
  it('come one week in three', () => {
    const weeks = Array.from({ length: 52 }, (_, i) => i + 1).filter(isQuestionWeek);
    expect(weeks.length).toBe(17);
  });

  it('rotate rather than repeat back to back', () => {
    expect(on(questionPost(3), 'threads').text).not.toBe(on(questionPost(6), 'threads').text);
  });

  it('carry no link', () => {
    for (const post of questionPost(3)) expect(post.text).not.toContain('http');
  });
});

describe('makerPost', () => {
  it('fits every platform and starts with a capital, for every week of the rotation', () => {
    for (let week = 1; week <= 7; week++) {
      for (const post of makerPost(week)) {
        withinLimit(post);
        expect(post.text[0]).toMatch(/["A-Z$]/);
      }
    }
  });
});

describe('featurePost', () => {
  // The real descriptions run to ~380 characters; one was rejected by Bluesky outright.
  const features: ShippedFeature[] = JSON.parse(
    readFileSync(join(__dirname, '../../../../data/shipped-features.json'), 'utf-8')
  );

  it('fits Bluesky for every shipped feature', () => {
    for (const feature of features) {
      for (const post of featurePost(feature)) withinLimit(post);
    }
  });
});

describe('LinkedIn', () => {
  it('rounds up the week with one image each and the links in the first comment', () => {
    const roundup = linkedinRoundup([
      artist(),
      artist({ name: 'Shadow Person', url: 'https://unstream.stream/a/shadow-person', location: null, platform: { id: 'jamcoop', name: 'Jam.coop', payout: '82-85%', release: null } }),
    ]);
    expect(roundup?.text).toMatch(/^Two independent artists featured on Unstream this week/);
    expect(roundup?.text).toContain('• Courstellation (Phoenix): Bandcamp');
    expect(roundup?.text).toContain('• Shadow Person: Jam.coop, 82-85% to the artist');
    expect(roundup?.text).not.toContain('http');
    expect(roundup?.firstComment).toContain('Shadow Person: https://unstream.stream/a/shadow-person');
    expect(roundup?.images).toHaveLength(2);
  });

  it('skips the roundup with fewer than two artists to list', () => {
    expect(linkedinRoundup([artist()])).toBeNull();
    expect(linkedinRoundup([artist(), artist({ platform: null })])).toBeNull();
  });

  it('keeps every weekday post link-free, with the link in the first comment', () => {
    for (let week = 1; week <= 5; week++) {
      const post = linkedinWeekdayPost(week, { bandcampFridayThisWeek: false });
      withinLimit(post);
      expect(post.text).not.toContain('http');
      expect(post.firstComment).toContain('https://unstream.stream');
    }
  });

  it('lists payouts exactly as the registry states them', () => {
    const texts = Array.from({ length: 5 }, (_, i) => linkedinWeekdayPost(i, { bandcampFridayThisWeek: false }).text);
    const comparison = texts.find(t => t.startsWith('Not every "buy" button'));
    expect(comparison).toContain(`Mirlo: ${PLATFORMS.mirlo.payoutPercent}`);
    expect(comparison).toContain(`Bandcamp: ${BANDCAMP_PAYOUT}`);
  });

  it('switches to a Bandcamp Friday heads-up in a week that has one', () => {
    expect(linkedinWeekdayPost(1, { bandcampFridayThisWeek: true }).text).toMatch(/^This Friday is Bandcamp Friday\./);
  });
});
