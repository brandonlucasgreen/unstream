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
 *
 * Instagram gets the indie spotlights only, as a carousel of cards Unstream draws itself
 * (api/shared/social-card.ts): six months of press photos reached a median of 3 accounts, after
 * Instagram stopped recommending accounts that mostly post other people's photos.
 */

import { PLATFORMS } from '../api/shared/platform-registry';
import {
  ARTIST_TAG_POSITION,
  cardAltText,
  cardSlides,
  fullSizeImageUrl,
  payoutFloor,
  purchaseMath,
  releaseNoun,
  socialCardUrl,
  type CardData,
  type FeaturedRelease,
} from '../api/shared/social-card';

export const UNSTREAM_BASE = 'https://unstream.stream';

export const CHARACTER_LIMITS = { threads: 500, bluesky: 300, instagram: 2200, linkedin: 3000 } as const;
export type Platform = keyof typeof CHARACTER_LIMITS;

export interface PostImage {
  url: string;
  altText: string;
  /** Instagram only: accounts tagged on the image, at 0-1 fractions of its width and height. */
  userTags?: { handle: string; x: number; y: number }[];
}

export interface SocialPost {
  platform: Platform;
  text: string;
  images: PostImage[];
  /** LinkedIn only. Company-page posts with a link in the body reach fewer people, so it goes here. */
  firstComment?: string;
}

/** Where to buy an artist's music, and a record of theirs that's there. */
export interface SellingPlatform {
  id: string;
  name: string;
  /** As the registry states it, e.g. "80-85%". Null when the registry has no figure. */
  payout: string | null;
  release: FeaturedRelease | null;
}

export interface ArtistContext {
  name: string;
  slug: string;
  /** Their Unstream page. */
  url: string;
  imageUrl: string | null;
  /** City when known, else country. */
  location: string | null;
  /** Only a handle taken from the artist's own Threads link — never their Instagram one (see threadsName). */
  threadsHandle: string | null;
  blueskyHandle: string | null;
  /** From the artist's own Instagram link. Tagged on Instagram only. */
  instagramHandle: string | null;
  platform: SellingPlatform | null;
}

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

/**
 * The artist's photo for one platform, or none. Threads and LinkedIn document JPEG and PNG (and
 * GIF on LinkedIn) as their image formats, not WebP, which is how Mirlo serves its avatars.
 * Buffer accepts a WebP when it schedules a post, but that says nothing about whether the
 * network takes it at publish time, so those two get no photo rather than risk the post. Bluesky
 * takes WebP.
 */
function artistImages(artist: Pick<ArtistContext, 'name' | 'imageUrl'>, platform: Platform): PostImage[] {
  if (!artist.imageUrl) return [];
  if (platform !== 'bluesky' && /\.webp($|\?)/i.test(artist.imageUrl)) return [];
  return [{ url: fullSizeImageUrl(artist.imageUrl), altText: `Photo of ${artist.name}` }];
}

// Letters NFKD doesn't split into a base letter and an accent, spelled the way subdomains do
// ("trentemoller" for Trentemøller).
const UNDECOMPOSED_LETTERS: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd' };

function comparableName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[øæœßłđ]/g, letter => UNDECOMPOSED_LETTERS[letter])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a Bandcamp address plausibly belongs to the artist it's filed under: the subdomain is
 * their name, give or take "the", "music", "official" or "band" ("melvinsofficial",
 * "thelemonheads").
 *
 * The prominent artists' Bandcamp links were matched by name when the artist files were
 * generated, and 161 of 791 point at someone else's page: "venomnoise" for Venom, "emperordnb"
 * for Emperor, "alanjackson1" for Alan Jackson. A post about one of those tells people that a
 * famous artist keeps a share of sales from a record they didn't make. This rejects some real
 * pages ("tmbg" for They Might Be Giants) to keep every false one out — a missing post costs
 * nothing, and the pool has 630 left for one post a week.
 */
export function bandcampMatchesArtist(name: string, url: string): boolean {
  const match = url.match(/^https:\/\/([a-z0-9-]+)\.bandcamp\.com\/?$/i);
  if (!match) return false;
  const subdomain = match[1].toLowerCase().replace(/-/g, '');
  const full = comparableName(name);
  const bare = full.replace(/^the/, '');
  if (!bare) return false;
  const stems = [full, bare, `the${bare}`];
  return stems.some(stem =>
    subdomain === stem
    || subdomain === `${stem}music`
    || subdomain === `${stem}official`
    || subdomain === `${stem}band`
    || subdomain === `official${stem}`
  );
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

// --- Indie spotlight (Mon, Tue, Wed, Fri, Sat on Threads, Bluesky and Instagram) ---

/**
 * The Instagram spotlight: a carousel of cards drawn from Unstream's own data (see
 * api/shared/social-card.ts), with the artist tagged on the first so it lands in their tagged
 * posts and they can reshare it. Tagged indie artists resharing were the only Instagram posts
 * that reached more than about ten accounts.
 *
 * Three hashtags at most, and never #newmusic or #newrelease: those were wrong on 72 of 75
 * prominent-artist posts and drew 58 of the 66 bot comments from July to September.
 *
 * Null when there are no cards to post, which is only when the card fonts can't draw the name.
 */
function instagramSpotlight(artist: ArtistContext, p: SellingPlatform, opts: { bandcampFriday: boolean }): SocialPost | null {
  const card: CardData = {
    artistName: artist.name,
    location: artist.location,
    platform: { id: p.id, name: p.name, payout: p.payout },
    release: p.release,
    imageUrl: artist.imageUrl,
  };
  const slides = cardSlides(card);
  if (slides.length === 0) return null;

  const handle = artist.instagramHandle;
  const images: PostImage[] = slides.map((slide, i) => ({
    url: socialCardUrl(UNSTREAM_BASE, artist.slug, slide, p.id, p.release?.slug ?? null),
    altText: cardAltText(slide, card),
    ...(i === 0 && handle ? { userTags: [{ handle, ...ARTIST_TAG_POSITION }] } : {}),
  }));

  const name = handle ? `${artist.name} (@${handle})` : artist.name;
  const from = artist.location ? `, from ${artist.location}` : '';
  const platformTag = opts.bandcampFriday && p.id === 'bandcamp' ? '#BandcampFriday' : `#${p.name.replace(/[^A-Za-z0-9]/g, '')}`;
  // Captions aren't links on Instagram, so the address is written to be read, not clicked.
  const address = artist.url.replace(/^https:\/\//, '');

  return {
    platform: 'instagram',
    text: `Today's artist: ${name}${from}.\n\n${spotlightBuyLine(p, opts.bandcampFriday, true)}\n\nEvery place to support them directly: ${address}\n\n${platformTag} #indiemusic #supportartists`,
    images,
  };
}

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

  const instagram = instagramSpotlight(artist, p, opts);
  return [
    { platform: 'threads', text: threads, images: artistImages(artist, 'threads') },
    { platform: 'bluesky', text: bluesky, images: artistImages(artist, 'bluesky') },
    ...(instagram ? [instagram] : []),
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

  if (opts.bandcampFridayTomorrow && p.id === 'bandcamp') {
    const what = album ?? `${artist.name}'s music`;
    return [
      {
        platform: 'threads',
        text: `Tomorrow is Bandcamp Friday. Bandcamp waives its cut for the day, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\nAny other day it's ${p.payout}. Streaming pays roughly $0.003 a play.\n\n${artist.url}`,
        images: artistImages(artist, 'threads'),
      },
      {
        platform: 'bluesky',
        text: fit('bluesky', [
          `Tomorrow is Bandcamp Friday: Bandcamp waives its cut, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\n${artist.url}\n\n#BandcampFriday #musicsky`,
          `Tomorrow is Bandcamp Friday: Bandcamp waives its cut, so buying ${what} there puts nearly everything you pay in ${artist.name}'s pocket.\n\n${artist.url}`,
        ]),
        images: artistImages(artist, 'bluesky'),
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
      images: artistImages(artist, 'threads'),
    },
    {
      platform: 'bluesky',
      text: fit('bluesky', [
        `${buying} On a $10 album that's at least ${math.take}, or around ${math.streams} streams.\n\n${artist.url}\n\n#musicsky`,
        `${buying} On a $10 album that's at least ${math.take}, or around ${math.streams} streams.\n\n${artist.url}`,
        `${buying}\n\n${artist.url}`,
      ]),
      images: artistImages(artist, 'bluesky'),
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
    threads: `Artists can claim their page on Unstream for free. It gathers every link where fans can buy your music or support you: Bandcamp, Faircamp, Mirlo, Patreon, whatever you've got.`,
    bluesky: `Artists: claim your free page on Unstream. Every link where fans can buy your music or support you, in one place.`,
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
    `Independent artists can claim their Unstream page for free. A verified page gathers every link where fans can buy their music or support them, from Bandcamp and Mirlo to Faircamp and Patreon, and shows fans which option pays the artist most.`,
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
    images: listed.flatMap(a => artistImages(a, 'linkedin')),
    firstComment: `Every place to support them directly:\n${listed.map(a => `${a.name}: ${a.url}`).join('\n')}`,
  };
}
