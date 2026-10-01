/**
 * Copy for the weekly social posts written by scripts/generate-social-posts.ts. Everything here
 * is pure — plain data in, text out, no fetching — so the copy can be tested.
 *
 * The shape of the week and of each post comes from a review of every post's metrics from
 * 22 Mar to 30 Sep 2026 (docs/engineering-history.md, "Social posts"). In short: wording barely
 * moved anything, reposts by the featured artist did, and only indie artists repost. So the
 * spotlights are written to be worth reposting, prominent artists are down to one post a week,
 * and questions to the audience are occasional by design rather than the end of every post.
 *
 * Payouts are read from api/shared/platform-registry.ts, the same figures the site shows. The
 * posts used to carry their own copy of them and drifted (Mirlo at 93% against the site's 86-90%).
 */

import { PLATFORMS } from '../api/shared/platform-registry';

export const UNSTREAM_BASE = 'https://unstream.stream';

export const CHARACTER_LIMITS = { threads: 500, bluesky: 300, linkedin: 3000 } as const;
export type Platform = keyof typeof CHARACTER_LIMITS;

export interface PostImage {
  url: string;
  altText: string;
}

export interface SocialPost {
  platform: Platform;
  text: string;
  images: PostImage[];
  /** LinkedIn only. Company-page posts with a link in the body reach fewer people, so it goes here. */
  firstComment?: string;
}

/** A record of theirs that's on the platform. `latest` only when it's the newest dated one there. */
export interface FeaturedRelease {
  title: string;
  type: string;
  latest: boolean;
}

/** Where to buy an artist's music, and a record of theirs that's there. */
export interface SellingPlatform {
  id: string;
  name: string;
  /** As the registry states it, e.g. "80-85%". Null when the registry has no figure. */
  payout: string | null;
  release: FeaturedRelease | null;
}

/** One row of an artist's release catalogue, as `/api/artist-page` returns it. */
export interface CatalogueRelease {
  title: string;
  releaseType: string;
  releaseDate: string | null;
  status: string;
  sources: { platform: string }[];
}

// Past this a title is more likely an ingest artefact than a name, and it would crowd the post.
const MAX_RELEASE_TITLE_LENGTH = 80;

/**
 * The record a spotlight names, from the artist's catalogue: the newest dated release on the
 * platform the post sends people to. Without dates (grid ingest often has none) it falls back to
 * the catalogue's first release there, which is the artist's own choice when they've arranged
 * their releases, but isn't called "latest", since nothing says it is.
 *
 * Only released records: an announced one is a pre-order, and "their latest album" would claim
 * it's out.
 */
export function pickCatalogueRelease(releases: CatalogueRelease[], platformId: string): FeaturedRelease | null {
  const onPlatform = releases.filter(r =>
    r.status === 'released'
    && r.title.trim().length > 0
    && r.title.length <= MAX_RELEASE_TITLE_LENGTH
    && r.sources.some(s => s.platform === platformId)
  );
  if (onPlatform.length === 0) return null;

  const newest = onPlatform
    .filter(r => r.releaseDate)
    .sort((a, b) => b.releaseDate!.localeCompare(a.releaseDate!))[0];
  const chosen = newest ?? onPlatform[0];
  return { title: chosen.title.trim(), type: chosen.releaseType, latest: !!newest };
}

export interface ArtistContext {
  name: string;
  /** Their Unstream page. */
  url: string;
  imageUrl: string | null;
  /** City when known, else country. */
  location: string | null;
  /** Only a handle taken from the artist's own Threads link — never their Instagram one (see threadsName). */
  threadsHandle: string | null;
  blueskyHandle: string | null;
  platform: SellingPlatform | null;
}

// The per-stream figure every post compares against. Spotify's average, widely reported.
const STREAM_PAYOUT_DOLLARS = 0.003;

// --- Small helpers ---

/** The first candidate that fits the platform's limit; the last one if none do, so the caller's
 * length check reports it rather than this silently posting something else. */
function fit(platform: Platform, candidates: string[]): string {
  return candidates.find(text => text.length <= CHARACTER_LIMITS[platform]) ?? candidates[candidates.length - 1];
}

/** Rotation through a list by week number. */
function pick<T>(items: T[], index: number): T {
  return items[index % items.length];
}

function releaseNoun(type: string): string {
  switch (type.toLowerCase()) {
    case 'album': return 'album';
    case 'ep': return 'EP';
    case 'single': return 'single';
    case 'track': return 'track';
    default: return 'release';
  }
}

/**
 * The low end of a registry payout ("80-85%" → 0.8, "~70%" → 0.7). The purchase math uses the
 * floor so a post never claims more for the artist than the site does.
 */
export function payoutFloor(payout: string): number | null {
  const match = payout.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) / 100 : null;
}

/** "$8", "$8.50" */
function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** What the artist gets from a $10 album at this payout, and how many streams pay the same. */
export function purchaseMath(payout: string): { take: string; streams: string } | null {
  const floor = payoutFloor(payout);
  if (floor === null) return null;
  const take = Math.round(10 * floor * 100) / 100;
  const streams = Math.round(take / STREAM_PAYOUT_DOLLARS / 100) * 100;
  return { take: dollars(take), streams: streams.toLocaleString('en-US') };
}

/**
 * Bandcamp image URLs carry a size code; the stored ones are mostly 300×300 (_23), which looks
 * soft in a feed. _10 is the 1200px rendition Bandcamp itself links for a full-size view. Anything
 * that isn't a Bandcamp image is returned as it is.
 */
export function fullSizeImageUrl(url: string): string {
  return url.replace(/^(https:\/\/f\d\.bcbits\.com\/img\/\w+)_\d+\.(jpg|png)$/, '$1_10.$2');
}

function artistImages(artist: Pick<ArtistContext, 'name' | 'imageUrl'>): PostImage[] {
  return artist.imageUrl ? [{ url: fullSizeImageUrl(artist.imageUrl), altText: `Photo of ${artist.name}` }] : [];
}

/**
 * "M Walker (@schmeeglez)" when the artist has a Threads link, else just the name.
 *
 * Never an Instagram handle on Threads, though they share a namespace: when Threads finds no
 * account by that name it publishes the post with the @ stripped, and 31 posts went out reading
 * "ko has music on Bandcamp" and "ianhunterdotcom has music on Bandcamp". With the name first,
 * a handle that fails to resolve still reads as a name.
 */
function threadsName(artist: ArtistContext): string {
  return artist.threadsHandle ? `${artist.name} (@${artist.threadsHandle})` : artist.name;
}

function blueskyName(artist: ArtistContext): string {
  return artist.blueskyHandle ? `${artist.name} (@${artist.blueskyHandle})` : artist.name;
}

/** The sentence about where to buy, shared by the Threads and Bluesky spotlights. */
function spotlightBuyLine(p: SellingPlatform, bandcampFriday: boolean, includeRelease: boolean): string {
  const release = includeRelease ? p.release : null;
  const latest = !release
    ? null
    : release.latest
      ? `Their latest ${releaseNoun(release.type)}, ${release.title}, is on ${p.name}`
      : `Their ${releaseNoun(release.type)} ${release.title} is on ${p.name}`;

  if (bandcampFriday && p.id === 'bandcamp') {
    return `${latest ?? 'Their music is on Bandcamp'}, and today is Bandcamp Friday: Bandcamp waives its cut, so nearly everything you pay goes to them.`;
  }
  if (latest && p.payout) return `${latest}. Buy it there and ${p.payout} of what you pay goes to them.`;
  if (latest) return `${latest}, where you can buy it directly.`;
  if (p.payout) return `Their music is on ${p.name}, where ${p.payout} of what you pay goes to them.`;
  return `You can buy their music directly on ${p.name}.`;
}

// --- Indie spotlight (Mon, Tue, Wed, Fri, Sat on Threads and Bluesky) ---

/**
 * A verified indie artist, written so they'd want to repost it: who they are, where they're from,
 * what they put out and where it pays them. Returns null for an artist with nowhere to buy their
 * music — the old fallback ("you can buy X's music directly… worth thinking about") was the worst
 * performer on every channel, so the caller picks someone else instead.
 */
export function indieSpotlight(artist: ArtistContext, opts: { bandcampFriday: boolean }): SocialPost[] | null {
  const p = artist.platform;
  if (!p) return null;

  const from = artist.location ? `, from ${artist.location}` : '';
  const images = artistImages(artist);
  const onBandcampFriday = opts.bandcampFriday && p.id === 'bandcamp';

  const threads = fit('threads', [
    `Today's artist: ${threadsName(artist)}${from}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, true)}\n\nEvery place to support them directly: ${artist.url}`,
    `Today's artist: ${threadsName(artist)}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, false)}\n\nEvery place to support them directly: ${artist.url}`,
  ]);

  const tags = onBandcampFriday ? '#BandcampFriday #musicsky' : '#musicsky #indiemusic';
  const bluesky = fit('bluesky', [
    `Today's artist: ${blueskyName(artist)}${from}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, true)}\n\n${artist.url}\n\n${tags}`,
    `Today's artist: ${blueskyName(artist)}${from}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, true)}\n\n${artist.url}`,
    `Today's artist: ${blueskyName(artist)}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, false)}\n\n${artist.url}`,
    `Today's artist: ${artist.name}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, false)}\n\n${artist.url}`,
  ]);

  return [
    { platform: 'threads', text: threads, images },
    { platform: 'bluesky', text: bluesky, images },
  ];
}

// --- Record math (Thu on Threads and Bluesky: the week's one prominent artist) ---

/**
 * A well-known artist, framed around what one purchase is worth to them. Untagged: none of the
 * prominent artists featured so far reposted, and their Instagram handles are what lost the @ on
 * Threads. Names an album only when the latest release is one, since the math is per album.
 * Returns null without a platform that has a payout figure, because the post is the figure.
 */
export function recordMath(artist: ArtistContext, opts: { bandcampFridayTomorrow: boolean }): SocialPost[] | null {
  const p = artist.platform;
  const math = p?.payout ? purchaseMath(p.payout) : null;
  if (!p || !p.payout || !math) return null;

  const album = p.release && p.release.type.toLowerCase() === 'album' ? p.release.title : null;
  const images = artistImages(artist);

  if (opts.bandcampFridayTomorrow && p.id === 'bandcamp') {
    const what = album ?? `${artist.name}'s music`;
    return [
      {
        platform: 'threads',
        text: `Tomorrow is Bandcamp Friday. Bandcamp waives its cut for the day, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\nAny other day it's ${p.payout}. Streaming pays roughly $0.003 a play.\n\n${artist.url}`,
        images,
      },
      {
        platform: 'bluesky',
        text: fit('bluesky', [
          `Tomorrow is Bandcamp Friday: Bandcamp waives its cut, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\n${artist.url}\n\n#BandcampFriday #musicsky`,
          `Tomorrow is Bandcamp Friday: Bandcamp waives its cut, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\n${artist.url}`,
        ]),
        images,
      },
    ];
  }

  const buying = album
    ? `Buying ${album} on ${p.name} instead of streaming it: ${artist.name} keeps ${p.payout} of what you pay.`
    : `Buying ${artist.name}'s music on ${p.name} instead of streaming it: they keep ${p.payout} of what you pay.`;

  return [
    {
      platform: 'threads',
      text: `${buying}\n\nOn a $10 album that's at least ${math.take}. At roughly $0.003 a stream, that's around ${math.streams} streams.\n\n${artist.url}`,
      images,
    },
    {
      platform: 'bluesky',
      text: fit('bluesky', [
        `${buying} On a $10 album that's at least ${math.take}, or around ${math.streams} streams.\n\n${artist.url}\n\n#musicsky`,
        `${buying} On a $10 album that's at least ${math.take}, or around ${math.streams} streams.\n\n${artist.url}`,
        `${buying}\n\n${artist.url}`,
      ]),
      images,
    },
  ];
}

// --- The occasional question (one Saturday in three, Threads and Bluesky) ---

// Plain questions that are worth answering, not reply bait. Kept rare on purpose: a question at
// the end of every post reads as a bot.
const QUESTIONS = [
  `What's the last album you paid for, rather than streamed?`,
  `What's a record you own that isn't on any streaming service?`,
  `Artists: what's on your Bandcamp, Mirlo or Faircamp right now? Leave a link.`,
  `If streaming disappeared tomorrow, whose music would you go and find first?`,
  `For people who stream everything: what would get you to buy music again?`,
];

export function isQuestionWeek(weekNumber: number): boolean {
  return weekNumber % 3 === 0;
}

export function questionPost(weekNumber: number): SocialPost[] {
  const question = pick(QUESTIONS, Math.floor(weekNumber / 3));
  return [
    { platform: 'threads', text: question, images: [] },
    { platform: 'bluesky', text: `${question}\n\n#musicsky`, images: [] },
  ];
}

// --- Maker posts (Sun on Threads and Bluesky) ---

// The best performers by far: about Unstream and the person who made it, text only. Repeats
// haven't worn out (the $0.003 post did better the second time), so this is a rotation.
const MAKER_POSTS: { threads: string; bluesky: string }[] = [
  {
    threads: `I built a free tool that searches 17+ platforms to help you find where to buy music directly from artists. No account, no tracking, no paywall.`,
    bluesky: `I built a free tool that searches 17+ platforms to find where to buy music directly from artists. No account needed.`,
  },
  {
    threads: `The average Spotify stream pays an artist about $0.003. One Bandcamp purchase can equal thousands of streams. That's why I made Unstream: it finds where you can buy an artist's music directly.`,
    bluesky: `$0.003 per Spotify stream. One Bandcamp purchase can equal thousands of streams. That's why I made Unstream.`,
  },
  {
    threads: `Artists can claim their page on Unstream for free. It puts all your direct-support links in one place: Bandcamp, Faircamp, Mirlo, Patreon, whatever you've got.`,
    bluesky: `Artists: claim your free page on Unstream. All your direct-support links in one place.`,
  },
  {
    threads: `Unstream is free, open source, and built by one person. No VC funding, no data harvesting, no premium tier. The whole point is getting more money to artists, not less.`,
    bluesky: `Unstream is free, open source, and built by one person. The whole point is getting more money to artists.`,
  },
  {
    threads: `Search for any artist on Unstream and it checks 17+ platforms (Bandcamp, Faircamp, Mirlo, Qobuz and more) in a few seconds, then shows where to buy their music directly, with what each platform pays the artist.`,
    bluesky: `Search any artist on Unstream: it checks 17+ platforms and shows where to buy their music directly, with what each one pays the artist.`,
  },
  {
    threads: `If you listen to music and care about the people who make it, this might be useful to you. Unstream finds where you can support any artist directly instead of streaming.`,
    bluesky: `If you care about the people who make the music you listen to, Unstream finds where to support them directly.`,
  },
  {
    threads: `"Support artists" shouldn't mean "stream them more." Buy one record a month from someone you love. That's the whole pitch.`,
    bluesky: `"Support artists" shouldn't mean "stream them more." Buy one record a month from someone you love. That's the whole pitch.`,
  },
];

export function makerPost(weekNumber: number): SocialPost[] {
  const post = pick(MAKER_POSTS, weekNumber);
  return [
    { platform: 'threads', text: `${post.threads}\n\n${UNSTREAM_BASE}`, images: [] },
    {
      platform: 'bluesky',
      text: fit('bluesky', [
        `${post.bluesky}\n\n${UNSTREAM_BASE}\n\n#musicsky #fairtrademusic`,
        `${post.bluesky}\n\n${UNSTREAM_BASE}`,
      ]),
      images: [],
    },
  ];
}

export interface ShippedFeature {
  id: string;
  title: string;
  /** Written to read as a standalone blurb after "…for Unstream:". */
  description: string;
  date: string;
  announced: boolean;
}

/**
 * A shipped feature, in place of the Sunday maker post. Feature descriptions run to ~380
 * characters, past Bluesky's 300, so Bluesky falls back to the title (one was rejected outright
 * for length on 2026-09-28 while the run reported success).
 */
export function featurePost(feature: ShippedFeature): SocialPost[] {
  return [
    { platform: 'threads', text: `I shipped something new for Unstream: ${feature.description}\n\n${UNSTREAM_BASE}`, images: [] },
    {
      platform: 'bluesky',
      text: fit('bluesky', [
        `I shipped something new for Unstream: ${feature.description}\n\n${UNSTREAM_BASE}\n\n#musicsky`,
        `I shipped something new for Unstream: ${feature.description}\n\n${UNSTREAM_BASE}`,
        `I shipped something new for Unstream: ${feature.title}.\n\n${UNSTREAM_BASE}`,
      ]),
      images: [],
    },
  ];
}

// --- LinkedIn (the Unstream company page: Tue and Thu, weekday afternoons) ---

// LinkedIn says it rewards one consistent topic in a human voice, and daily artist spotlights
// from a company page are neither, so the page gets two posts a week about the economics. The
// page speaks as Unstream: full sentences, no "I".

/** The platforms the payout comparison lists, highest floor first. */
const PAYOUT_COMPARISON = ['subvert', 'ampwall', 'faircamp', 'mirlo', 'jamcoop', 'bandcamp'];

function payoutComparison(): string {
  const rows = PAYOUT_COMPARISON
    .flatMap(id => {
      const payout = PLATFORMS[id]?.payoutPercent;
      return payout ? [{ name: PLATFORMS[id].name, payout }] : [];
    })
    .sort((a, b) => (payoutFloor(b.payout) ?? 0) - (payoutFloor(a.payout) ?? 0))
    .map(p => `${p.name}: ${p.payout}`);
  return `Not every "buy" button pays artists the same. Roughly how much of a sale reaches the artist on some of the platforms Unstream searches:\n\n${rows.join('\n')}\n\nUnstream shows these figures next to every search result, so fans can see where their money does the most.`;
}

function bandcampMath(): { take: string; streams: string } {
  // The registry always carries Bandcamp's payout; a missing one is a broken registry, not a
  // reason to post a sentence with a hole in it.
  const math = PLATFORMS.bandcamp?.payoutPercent ? purchaseMath(PLATFORMS.bandcamp.payoutPercent) : null;
  if (!math) throw new Error('platform-registry: Bandcamp has no usable payoutPercent');
  return math;
}

function linkedinEconomics(): string[] {
  const { take, streams } = bandcampMath();
  return [
    `Most "support artists" advice ends with "stream them more." The math says otherwise.\n\nA stream pays an artist roughly $0.003. A $10 album on Bandcamp pays them at least ${take}, around ${streams} streams' worth.\n\nUnstream is a free tool that shows where to buy any artist's music directly across 17+ platforms, along with what each platform pays the artist.`,
    payoutComparison(),
    `Unstream is free and built by one person. It has no investors, no data harvesting and no premium tier, for fans or for artists.\n\nThe goal is simple: get more of the money fans spend on music to the people who make it.`,
    `Independent artists can claim their Unstream page for free. A verified page gathers every direct-support link in one place, from Bandcamp and Mirlo to Faircamp and Patreon, and shows fans which option pays the artist most.`,
    `Search for any artist on Unstream and within a few seconds it checks more than 17 platforms, including Bandcamp, Faircamp, Mirlo and Jam.coop. The results show where you can buy their music directly, and roughly what share of each sale reaches the artist.`,
  ];
}

/** Tuesday's page post: an economics post in rotation, or a Bandcamp Friday heads-up in a week that has one. */
export function linkedinWeekdayPost(weekNumber: number, opts: { bandcampFridayThisWeek: boolean }): SocialPost {
  const text = opts.bandcampFridayThisWeek
    ? `This Friday is Bandcamp Friday. For 24 hours, Bandcamp waives its share of every sale, so nearly everything fans spend goes to the artists they buy from.\n\nIf there is an album you have been meaning to buy, Friday is the day to do it.`
    : pick(linkedinEconomics(), weekNumber);
  return {
    platform: 'linkedin',
    text: `${text}\n\n#MusicIndustry`,
    images: [],
    firstComment: `Find where to buy any artist's music directly: ${UNSTREAM_BASE}`,
  };
}

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];

/**
 * Thursday's page post: the artists spotlighted earlier in the week, one image each. Needs at
 * least two with somewhere to buy, or it isn't a roundup.
 */
export function linkedinRoundup(artists: ArtistContext[]): SocialPost | null {
  const listed = artists.filter(a => a.platform).slice(0, COUNT_WORDS.length - 1);
  if (listed.length < 2) return null;

  const lines = listed.map(a => {
    const where = a.location ? ` (${a.location})` : '';
    const payout = a.platform!.payout ? `, ${a.platform!.payout} to the artist` : '';
    return `• ${a.name}${where}: ${a.platform!.name}${payout}`;
  });
  const { take, streams } = bandcampMath();

  return {
    platform: 'linkedin',
    text: `${COUNT_WORDS[listed.length]} independent artists featured on Unstream this week, and where you can buy their music directly:\n\n${lines.join('\n')}\n\nFor scale: a $10 album on Bandcamp pays an artist at least ${take}. Earning that from streaming takes roughly ${streams} plays.\n\n#IndependentMusic`,
    images: listed.flatMap(artistImages),
    firstComment: `Every place to support them directly:\n${listed.map(a => `${a.name}: ${a.url}`).join('\n')}`,
  };
}
