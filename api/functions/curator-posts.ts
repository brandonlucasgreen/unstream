// Turning a curator's template and a list of artists into the caption and tags for one network.
// Pure: no I/O, no environment, no Buffer. See docs/specs/curator-posts-spec.md, "Templates".
//
// **Unstream writes no copy.** Every variable here resolves to a fact we already hold about the
// artist; the sentences around them are the curator's own. That is the line that makes this
// acceptable where auto-writing an artist's own posts would not be.
//
// The caller supplies artists already looked up on the server. Nothing in this file trusts a
// handle, payout or link that arrived from a browser.

import { PLATFORMS } from '../shared/platform-registry';
import { isSearchUrl } from '../shared/social-card';

export const UNSTREAM_BASE = 'https://unstream.stream';

/** Instagram and Facebook only. TikTok and YouTube need video, which Unstream can't make. */
export type CuratorNetwork = 'instagram' | 'facebook';

/**
 * Caption limits, as the networks document them.
 *
 * **Not from Buffer's `configuration` query.** That reports `configurationContentTypes:
 * ["comment"]` — first-comment limits, not caption limits. It says 5000 for a Facebook page,
 * where a post's real limit is 63206, so reading it as a caption limit would reject valid posts
 * (measured against the live API, 2026-10-27).
 */
export const CAPTION_LIMITS: Record<CuratorNetwork, number> = {
  instagram: 2200,
  facebook: 63206,
};

/**
 * Hashtags no curator post may carry.
 *
 * Measured on Unstream's own account: these were wrong on 72 of 75 prominent-artist posts and
 * drew 58 of the 66 bot comments from July to September 2026.
 */
const BANNED_HASHTAGS = new Set(['newmusic', 'newrelease']);

/** Three at most, which is the ceiling the generator's own posts observe. */
const MAX_HASHTAGS = 3;

export interface CuratorArtist {
  id: string;
  name: string;
  slug: string;
  /** City when known, else country. Null when we don't hold one. */
  location: string | null;
  /** The artist's own profile URLs, by network, as stored in artist_links. */
  links: Partial<Record<CuratorNetwork, string | null>>;
  /** The release the curator picked, else their latest catalogued one, else null. */
  release: { title: string } | null;
  /** Where to buy, for {payout}. Null when they have no selling link the registry knows. */
  platform: { id: string; name: string } | null;
}

/** The curator's own names for themselves, set once. */
export interface CuratorProfile {
  showName: string | null;
  labelName: string | null;
  /** The curator's own handle per network: the Instagram one signs the cards ("via @…"). */
  handles: Partial<Record<CuratorNetwork, string | null>>;
  /**
   * Their Unstream username, for Instagram's several-artist {link} to unstream.stream/u/{it}.
   * Not their Instagram handle: the two are different names on different sites, and conflating
   * them sent captions to someone else's page, or to none.
   */
  unstreamHandle: string | null;
}

export interface CuratorTemplate {
  /** The wrapper, e.g. "Tonight on {show}:\n\n{artists}\n\nBuy direct: {link}" */
  postText: string;
  /** Repeated per artist and joined into {artists}, e.g. "{artist} – {release}" */
  lineText: string;
  hashtags: string[];
}

/**
 * Handles the curator typed in themselves, keyed by artist id.
 *
 * Kept apart from the artist's own links on purpose: a handle typed by a stranger is unverified
 * however plausible it looks, so it is used for that curator's posts and never written back to
 * artist_links.
 */
export type AddressBook = Record<string, Partial<Record<CuratorNetwork, string | null>>>;

// ---------------------------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------------------------

/** "kidlightbulbs" from instagram.com/kidlightbulbs/, ignoring share parameters (?igsh=). */
export function parseInstagramHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'instagram.com' && !parsed.hostname.endsWith('.instagram.com')) return null;
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0].replace(/^@/, '');
    // Post, reel and story links name no account.
    if (['p', 'reel', 'reels', 'explore', 'stories', 'tv'].includes(segment)) return null;
    return isValidHandle('instagram', segment) ? segment : null;
  } catch { return null; }
}

/**
 * "kidlightbulbs" from facebook.com/kidlightbulbs.
 *
 * Facebook's numeric `profile.php?id=` form is rejected: it names an account but isn't a handle
 * anyone can type, and a Page mention needs the Page id separately anyway.
 */
export function parseFacebookHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('facebook.com') && !parsed.hostname.endsWith('fb.com')) return null;
    const segment = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0].replace(/^@/, '');
    if (!segment || segment === 'profile.php' || ['pages', 'groups', 'events', 'watch'].includes(segment)) return null;
    return isValidHandle('facebook', segment) ? segment : null;
  } catch { return null; }
}

/**
 * Whether a handle is one its network could have issued.
 *
 * This is the only check standing between a typo and a failed publish: **Buffer accepts and
 * stores a handle that doesn't exist**, with no error at creation and none asynchronously
 * (measured 2026-10-27). It can't tell us an account is real, only that the string is shaped
 * like one — which still catches pasted URLs, stray @s and empty input.
 */
export function isValidHandle(network: CuratorNetwork, handle: string): boolean {
  if (network === 'instagram') return /^[A-Za-z0-9._]{1,30}$/.test(handle);
  return /^[A-Za-z0-9.]{5,50}$/.test(handle);
}

/**
 * The handle to tag this artist with on this network, or null.
 *
 * Order: the artist's own link for **that** network, then the curator's address book, then
 * nothing. One network's handle is never derived from another's — an Instagram handle that
 * Threads couldn't resolve is the bug behind the generator's existing Threads rule.
 */
export function handleFor(
  artist: CuratorArtist,
  network: CuratorNetwork,
  addressBook: AddressBook = {},
): string | null {
  const parse = network === 'instagram' ? parseInstagramHandle : parseFacebookHandle;
  const own = parse(artist.links[network]);
  if (own) return own;

  const typed = addressBook[artist.id]?.[network];
  if (typed && isValidHandle(network, typed)) return typed;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

/** "keeps 80-85% on Bandcamp", or null when the registry has no figure for their platform. */
export function payoutPhrase(platform: CuratorArtist['platform']): string | null {
  if (!platform) return null;
  const payout = PLATFORMS[platform.id]?.payoutPercent;
  if (!payout) return null;
  return `keeps ${payout} on ${PLATFORMS[platform.id].name}`;
}

/**
 * Where the post sends people.
 *
 * One artist is their Unstream page, which lists every place to buy with its payout — the whole
 * point of the link. Several artists differ by network, because Instagram makes nothing
 * clickable: Facebook carries a link each, Instagram points at the curator's own /u/ page, and
 * falls back to "link in bio" when they haven't claimed a handle.
 */
function linkValue(artists: CuratorArtist[], network: CuratorNetwork, curator: CuratorProfile): string {
  if (artists.length === 1) {
    const page = `${UNSTREAM_BASE}/a/${artists[0].slug}`;
    return network === 'facebook' ? page : page.replace(/^https:\/\//, '');
  }
  if (network === 'facebook') {
    // Its own block: a run of links reads badly trailing off the end of the curator's sentence.
    return `\n${artists.map(a => `${a.name}: ${UNSTREAM_BASE}/a/${a.slug}`).join('\n')}`;
  }
  const handle = curator.unstreamHandle;
  // No label of our own in front of it — the curator's template supplies the wording, and
  // Unstream writes no copy. "link in bio" is the one exception, because there is no address to
  // give when the curator has no public Unstream page.
  return handle ? `unstream.stream/u/${handle}` : 'link in bio';
}

/**
 * Substitute one variable, taking with it any space or separator left stranded in front of it.
 *
 * `{artist} – {release}` with no release has to read "Artist", not "Artist –", and
 * `Tonight on {show}:` with no show has to read "Tonight on:", not "Tonight on :".
 *
 * Only *horizontal* space is absorbed. `\s` would eat the newlines around `{artists}` in the
 * post template and run the curator's paragraphs together.
 */
function substitute(text: string, name: string, value: string | null): string {
  if (value) return text.replaceAll(`{${name}}`, value);
  return text.replace(new RegExp(`[ \\t]*(?:[–—-][ \\t]*)?\\{${name}\\}`, 'g'), '');
}

/** One artist's line. */
function renderLine(
  artist: CuratorArtist,
  template: CuratorTemplate,
  network: CuratorNetwork,
  addressBook: AddressBook,
): string {
  // **Only Instagram gets an @handle.** There, an @ in the caption notifies the account. On
  // Facebook it notifies nobody: a Page mention is an `annotations` entry carrying the Page's
  // *numeric* id, which we don't hold for an artist and can't derive from their
  // facebook.com/name link. So Facebook gets the artist's name — which is also the text an
  // annotation's `indices` would have to point at, if we ever get those ids.
  const handle = network === 'instagram' ? handleFor(artist, network, addressBook) : null;
  let line = substitute(template.lineText, 'artist', handle ? `@${handle}` : artist.name);
  line = substitute(line, 'release', artist.release?.title ?? null);
  line = substitute(line, 'payout', payoutPhrase(artist.platform));
  line = substitute(line, 'location', artist.location);
  return line.replace(/[ \t]{2,}/g, ' ').trim();
}

/** At most three, none of them banned, each normalised to a single leading #. */
export function cleanHashtags(hashtags: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of hashtags) {
    const bare = raw.trim().replace(/^#+/, '');
    if (!bare) continue;
    const key = bare.toLowerCase();
    if (BANNED_HASHTAGS.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(`#${bare}`);
    if (kept.length === MAX_HASHTAGS) break;
  }
  return kept;
}

export interface RenderInput {
  template: CuratorTemplate;
  artists: CuratorArtist[];
  network: CuratorNetwork;
  curator: CuratorProfile;
  addressBook?: AddressBook;
}

/** The finished caption for one network. */
export function renderCaption(input: RenderInput): string {
  const { template, artists, network, curator, addressBook = {} } = input;

  const lines = artists.map(a => renderLine(a, template, network, addressBook)).filter(Boolean);

  let caption = substitute(template.postText, 'artists', lines.join('\n'));
  caption = substitute(caption, 'show', curator.showName);
  caption = substitute(caption, 'label', curator.labelName);
  caption = substitute(caption, 'link', linkValue(artists, network, curator));

  const tags = cleanHashtags(template.hashtags);
  if (tags.length) caption = `${caption.trimEnd()}\n\n${tags.join(' ')}`;

  // Collapse the blank-line runs a dropped {show} or {artists} leaves, without touching the
  // paragraph breaks the curator typed.
  return caption.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Why this caption can't be sent, or null.
 *
 * Neither network supports a thread, so an over-long caption is an error the curator has to fix
 * rather than something to split. Buffer would otherwise reject it inside a content item, which
 * is all-or-nothing and would take the other network's post down too.
 */
export function captionProblem(network: CuratorNetwork, caption: string): string | null {
  if (!caption.trim()) return 'The caption is empty.';
  const limit = CAPTION_LIMITS[network];
  if (caption.length > limit) {
    return `${caption.length} characters, over ${network === 'instagram' ? 'Instagram' : 'Facebook'}'s ${limit}.`;
  }
  return null;
}

/**
 * The one built-in template for the hackathon cut ("Tonight's show"). Saved templates come later,
 * so this is a starting point the curator edits in the page, not a default they're stuck with.
 */
export const DEFAULT_TEMPLATE: CuratorTemplate = {
  postText: "Tonight on {show}:\n\n{artists}\n\nBuy their music, don't just stream it: {link}",
  lineText: '{artist} – {release}',
  hashtags: [],
};

// ---------------------------------------------------------------------------------------------
// Picking where to buy
// ---------------------------------------------------------------------------------------------

/**
 * Platforms that sell music, so a post can say "buy it there".
 *
 * Patronage platforms (Patreon, Ko-fi, Buy Me a Coffee) can't headline a post for that reason.
 * `scripts/generate-social-posts.ts` keeps its own copy of this list for the weekly spotlights;
 * the two are allowed to differ, since the posts differ, but a platform added to one is usually
 * wanted in the other.
 */
export const SELLING_PLATFORMS = new Set([
  'bandcamp', 'faircamp', 'mirlo', 'qobuz', 'ampwall', 'bandwagon', 'jamcoop',
]);

/** The shape of a stored artist link, as `getArtistsBySlugs` returns it. */
export interface ArtistLinkLike {
  sourceId: string;
  url: string;
  latestRelease?: { title: string };
}

/**
 * The artist's first selling link in display order, with the release that link knows about.
 *
 * Display order is the artist's own ordering, so the first selling link is the one they lead
 * with. A search link is skipped: it proves nothing about the artist being on that platform
 * (`isSearchUrl`), and a card or caption may not say their music is somewhere it might not be.
 */
export function sellingPlatformFrom(links: ArtistLinkLike[]): {
  platform: CuratorArtist['platform'];
  release: CuratorArtist['release'];
} {
  const link = links.find(l => SELLING_PLATFORMS.has(l.sourceId) && !isSearchUrl(l.url));
  if (!link) return { platform: null, release: null };
  const meta = PLATFORMS[link.sourceId];
  return {
    platform: { id: link.sourceId, name: meta?.name ?? link.sourceId },
    release: link.latestRelease?.title ? { title: link.latestRelease.title } : null,
  };
}

/** The artist's own profile URL for a network, from their stored links. */
export function linkUrlFor(links: ArtistLinkLike[], network: CuratorNetwork): string | null {
  return links.find(l => l.sourceId === network)?.url ?? null;
}
