/**
 * What a curator's Instagram carousel says, and what it may say.
 *
 * The companion to social-card.ts, which does the same job for the weekly generator's indie
 * spotlights. They're kept apart because the two families answer to different rules: a spotlight
 * card states only what the *artist's* own data does, while a curator card carries the curator's
 * own framing — their show name, their handle in the footer — around the same artist facts.
 *
 * Drawn by renderCuratorCard in scripts/social-card-render.ts. Shared so the function drawing
 * them and anything describing them agree on the shape. See docs/specs/curator-posts-spec.md.
 */

export const CURATOR_CARD_SLIDES = ['cover', 'curator-artist'] as const;
export type CuratorCardSlide = (typeof CURATOR_CARD_SLIDES)[number];

/** Instagram's own ceiling through Buffer is 10 images, so a cover plus nine artists. */
export const MAX_CURATOR_ARTIST_CARDS = 9;

/** The curator's framing, drawn on every card of the set. */
export interface CuratorCardFrame {
  /** The kicker, e.g. "Tonight on Night Shift". Drawn upper-case. Null leaves the line out. */
  kicker: string | null;
  /** The curator's own handle, for the "via @handle · unstream.stream" footer. */
  viaHandle: string | null;
}

export interface CuratorCardArtist {
  name: string;
  /** City when known, else country. */
  location: string | null;
  /** The release title, when one was picked or catalogued. */
  release: string | null;
  /** As the registry states it, e.g. "80-85%". */
  payout: string | null;
  platformName: string | null;
  /**
   * The handle this artist will be tagged with on the post, without the @.
   *
   * Drawn as a bubble on the cover so the curator can see who gets tagged before sending.
   * Null draws no bubble — a missing handle is the normal case, not an error.
   */
  handle: string | null;
}

export type CuratorCardData =
  | { slide: 'cover'; frame: CuratorCardFrame; artists: CuratorCardArtist[] }
  | { slide: 'curator-artist'; frame: CuratorCardFrame; artist: CuratorCardArtist };

/** What a screen reader is told. Instagram requires alt text on every image Buffer sends. */
export function curatorCardAltText(data: CuratorCardData): string {
  if (data.slide === 'cover') {
    const names = data.artists.map(a => a.name).join(', ');
    return `${data.frame.kicker ?? 'On Unstream'}: ${names}.`;
  }
  const { name, location, release, payout, platformName } = data.artist;
  const where = location ? `${name} from ${location}` : name;
  const record = release ? `, ${release}` : '';
  const pays = payout && platformName ? `. ${platformName} pays them ${payout} of what you pay.` : '.';
  return `${where}${record}${pays}`;
}
