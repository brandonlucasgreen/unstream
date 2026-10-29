// Release autopost: which networks it writes for, and what each one takes
// (docs/specs/release-autopost-spec.md, "Networks"). Shared by the server, which checks every post
// against these before Buffer sees it, and the Promote page, which lists the artist's channels.
//
// **Which networks is Unstream's choice, not Buffer's**: Buffer can post to all of them. Autopost
// posts text with an image, so it leaves out the networks that need a video (YouTube) and the ones
// that need more than that from setup (Pinterest's board, Google Business's post type). TikTok
// takes photo posts, so it's in, with the same rules as Instagram (see IMAGE_FIRST_NETWORKS).

/**
 * The longest post each network takes, as Buffer counts it (UTF-16 code units, which is also what
 * a JavaScript string's length counts). From Buffer's developer guide, "Character limits"
 * (developers.buffer.com/guides/character-limits), checked 2026-10-29.
 *
 * Bluesky counts graphemes, so a length check here is stricter than Bluesky's own and never lets
 * a long post through. Mastodon's limit is set by each server; 500 is the default. Buffer doesn't
 * publish one for Substack, so 1,000 is a cautious guess: the default posts are about 250.
 */
export const AUTOPOST_NETWORK_LIMITS: Record<string, number> = {
  instagram: 2196,
  facebook: 5000,
  threads: 500,
  bluesky: 300,
  mastodon: 500,
  linkedin: 3000,
  substack: 1000,
  // TikTok's limit for photo posts; a video post's is 2,200.
  tiktok: 4000,
};

/**
 * The networks that need an image on every post and have no clickable links in captions:
 * Instagram and TikTok (Brandon, 2026-10-29). Each post there carries a fresh image (the planner's
 * four-week no-repeat rule), or that network skips it, and `{link}` reads "link in bio".
 */
export const IMAGE_FIRST_NETWORKS: readonly string[] = ['instagram', 'tiktok'];

export function isImageFirstNetwork(service: string): boolean {
  return IMAGE_FIRST_NETWORKS.includes(service);
}

export function isAutopostNetwork(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTOPOST_NETWORK_LIMITS, service);
}

/** Buffer's service ids as people write them. Anything missing falls back to the id. */
const NETWORK_NAMES: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  linkedin: 'LinkedIn',
  substack: 'Substack',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  startPage: 'Start Page',
  googlebusiness: 'Google Business',
  twitter: 'X',
};

export function networkName(service: string): string {
  return NETWORK_NAMES[service] ?? service;
}
