/**
 * The Instagram carousel for an indie spotlight: which slides a post gets, and the facts on each.
 *
 * Instagram stopped recommending accounts that mostly post other people's photos on 30 April
 * 2026, and a daily press photo was exactly that: median reach 3 accounts over 177 posts
 * (docs/specs/instagram-original-posts-spec.md). So the carousel is made from Unstream's own
 * data — where to buy, the registry payout, the record, the purchase math — and only the last
 * slide is the artist's photo, credited to where it came from.
 *
 * Pure, and shared by the renderer (api/functions/social-card.ts draws the slides) and the post
 * generator (scripts/generate-social-posts.ts links them and writes their alt text), so a slide
 * and its alt text are built from the same figures.
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

/** In carousel order. The photo goes last: it's the one slide that isn't Unstream's own work. */
export const CARD_SLIDES = ['buy', 'record', 'math', 'photo'] as const;
export type CardSlide = (typeof CARD_SLIDES)[number];

/**
 * Where the artist is tagged on the first slide, as Instagram's 0-1 fractions of the image. The
 * renderer centres the artist's name here. On a carousel the first image's tags apply to every
 * slide, so this is the only tag a post needs.
 */
export const ARTIST_TAG_POSITION = { x: 0.5, y: 0.4 };

/** One row of an artist's release catalogue, as `/api/artist-page` returns it. */
export interface CatalogueRelease {
  slug: string;
  title: string;
  releaseType: string;
  releaseDate: string | null;
  status: string;
  artworkUrl: string | null;
  sources: { platform: string }[];
}

/**
 * A record of theirs that's on the platform. `latest` only when it's the newest dated one there.
 * `slug` and `artworkUrl` are null for a release that isn't in a catalogue (the prominent
 * artists' generated files), which also means it gets no card.
 */
export interface FeaturedRelease {
  title: string;
  type: string;
  latest: boolean;
  slug: string | null;
  artworkUrl: string | null;
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
 *
 * Here rather than with the post copy because the card renderer applies it too, to say "latest"
 * on the record slide by the same rule the caption used.
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
  return { title: chosen.title.trim(), type: chosen.releaseType, latest: !!newest, slug: chosen.slug, artworkUrl: chosen.artworkUrl };
}

export interface CardData {
  artistName: string;
  /** City when known, else country. */
  location: string | null;
  platform: { id: string; name: string; payout: string | null };
  release: Pick<FeaturedRelease, 'title' | 'type' | 'latest' | 'artworkUrl'> | null;
  imageUrl: string | null;
}

// The per-stream figure every post compares against. Spotify's average, widely reported.
const STREAM_PAYOUT_DOLLARS = 0.003;

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

export function releaseNoun(type: string): string {
  switch (type.toLowerCase()) {
    case 'album': return 'album';
    case 'ep': return 'EP';
    case 'single': return 'single';
    case 'track': return 'track';
    default: return 'release';
  }
}

/**
 * A link that searches a platform for the artist rather than pointing at them — the generated
 * artist files carry some (Ampwall's explore page, DuckDuckGo site: searches). It proves nothing
 * about the artist being there, so neither a post nor a card may say their music is.
 */
export function isSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('duckduckgo')
      || /\/(search|explore)/.test(parsed.pathname)
      || parsed.searchParams.has('q')
      || parsed.searchParams.has('query');
  } catch {
    return true;
  }
}

/**
 * Whether the card's fonts can draw this text. They cover Latin scripts (Darker Grotesque and
 * Stack Sans Headline, both with Vietnamese), and resvg draws nothing at all for a glyph no
 * loaded font has, so a name in Japanese would go out as a blank card rather than fall back.
 */
export function cardFontsCanDraw(text: string): boolean {
  return /^[\p{Script=Latin}\p{Mn} -@[-`{-~ -¿×÷‐-‧‰-⁞€™]*$/u.test(text);
}

/**
 * The slides this artist's carousel has: the "buy" card always, the others when there's
 * something to put on them. None when their name can't be drawn, since every slide carries it.
 */
export function cardSlides(data: CardData): CardSlide[] {
  if (!cardFontsCanDraw(data.artistName)) return [];
  return CARD_SLIDES.filter(slide => {
    switch (slide) {
      case 'buy': return true;
      case 'record': return !!data.release?.artworkUrl && cardFontsCanDraw(data.release.title);
      case 'math': return !!data.platform.payout && purchaseMath(data.platform.payout) !== null;
      case 'photo': return !!data.imageUrl;
    }
  });
}

/**
 * Bandcamp image URLs carry a size code; the stored ones are mostly 300×300 (_23), which looks
 * soft in a feed. _10 is the 1200px rendition Bandcamp itself links for a full-size view. Anything
 * that isn't a Bandcamp image is returned as it is.
 */
export function fullSizeImageUrl(url: string): string {
  return url.replace(/^(https:\/\/f\d\.bcbits\.com\/img\/\w+)_\d+\.(jpg|png)$/, '$1_10.$2');
}

/**
 * The rendition of an image the card draws: Bandcamp's full size, and for Mirlo a JPEG. Mirlo
 * serves covers as WebP, which the renderer can't decode, but publishes the same cover as
 * `-x1500.jpg` (checked against three covers, 2026-10-01). Its avatars have no JPEG rendition,
 * so those stay WebP and the renderer refuses them.
 */
export function cardImageUrl(url: string): string {
  return fullSizeImageUrl(url)
    .replace(/^(https:\/\/cdn\.mirlo\.space\/file\/trackgroup-covers\/[0-9a-f-]+)-x\d+\.webp(\?.*)?$/, '$1-x1500.jpg');
}

/** Where an artist photo came from, for its credit line. Null when the host is none of these. */
export function photoSource(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)bcbits\.com$/.test(hostname)) return 'Bandcamp';
  if (hostname === 'cdn.mirlo.space') return 'Mirlo';
  if (hostname === 'yt3.googleusercontent.com') return 'YouTube';
  return null;
}

function fromLocation(data: CardData): string {
  return data.location && cardFontsCanDraw(data.location) ? `, from ${data.location}` : '';
}

/** One sentence per slide saying what the slide shows, for Instagram's alt text. */
export function cardAltText(slide: CardSlide, data: CardData): string {
  const { artistName: name, platform } = data;
  switch (slide) {
    case 'buy':
      return platform.payout
        ? `${name}${fromLocation(data)}. Buy their music on ${platform.name}, where ${platform.payout} of what you pay goes to the artist.`
        : `${name}${fromLocation(data)}. Buy their music directly on ${platform.name}.`;
    case 'record': {
      const release = data.release;
      if (!release) return `A record by ${name}.`;
      const latest = release.latest ? `, their latest ${releaseNoun(release.type)}` : '';
      return `Cover art for ${release.title} by ${name}${latest}, on ${platform.name}.`;
    }
    case 'math': {
      const math = platform.payout ? purchaseMath(platform.payout) : null;
      if (!math) return `Buy ${name}'s music on ${platform.name}.`;
      return `A $10 album on ${platform.name} pays ${name} at least ${math.take}. At roughly $0.003 a stream, that's around ${math.streams} streams.`;
    }
    case 'photo': {
      const source = data.imageUrl ? photoSource(data.imageUrl) : null;
      return source ? `Photo of ${name}, from their ${source} page.` : `Photo of ${name}.`;
    }
  }
}

/**
 * A slide's public URL. The platform and the release are chosen when the post is written and
 * travel in the URL, so a slide rendered on publish day — Buffer fetches images then, up to two
 * weeks later — shows the same record the caption names even if the artist has released another.
 */
export function socialCardUrl(
  base: string,
  artistSlug: string,
  slide: CardSlide,
  platformId: string,
  releaseSlug: string | null
): string {
  const params = new URLSearchParams({ platform: platformId });
  if (releaseSlug) params.set('release', releaseSlug);
  return `${base}/api/social-card/${encodeURIComponent(artistSlug)}/${slide}.png?${params}`;
}
