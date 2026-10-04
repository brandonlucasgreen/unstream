// Does the website a claimant verified with belong to the artist, by a source other than them?
//
// The link-back check alone proves only that the claimant controls *some* page that names the
// artist and links to unstream.stream/a/<slug> — any free host does. Verifying on that alone
// let anyone claim an unclaimed artist and replace their Bandcamp/Patreon/Ko-fi links with
// their own. So a claim is approved instantly only when the website is one we already hold for
// the artist from somewhere else (MusicBrainz's official homepage, a Bandcamp account found by
// search); everything else becomes a manual-review request at /admin/verify.
//
// Residual trust: those stored links come from MusicBrainz, which anyone can edit, or from a
// Bandcamp subdomain that matched the artist's name. Much harder to plant than a page on a
// free host, but not impossible; a reviewer is the backstop.

/** The stored link platforms that identify the artist's own site. */
const IDENTIFYING_PLATFORMS = new Set(['officialsite', 'bandcamp']);

// Hosts shared by many accounts, where identity lives in the path rather than the hostname.
// linktr.ee/someone-else must not match linktr.ee/the-artist.
const SHARED_HOSTS = new Set([
  'linktr.ee',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'soundcloud.com',
  'tiktok.com',
  'bandcamp.com',
  'sites.google.com',
  'myspace.com',
  'patreon.com',
  'ko-fi.com',
  'beacons.ai',
  'campsite.bio',
]);

export interface StoredLink {
  platform: string;
  url: string;
  source: string | null;
}

/** Hostname without `www.`, plus the first path segment on shared hosts; null if unparseable. */
function siteIdentity(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!SHARED_HOSTS.has(host)) return host;
  const firstSegment = parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  // A bare shared host (linktr.ee/) identifies nobody.
  return firstSegment ? `${host}/${firstSegment}` : null;
}

export function websiteMatchesKnownLink(websiteUrl: string, links: StoredLink[]): boolean {
  const claimed = siteIdentity(websiteUrl);
  if (!claimed) return false;
  return links.some(
    link =>
      IDENTIFYING_PLATFORMS.has(link.platform) &&
      // A link the claimant (or an earlier claimant) added proves nothing about this claim.
      link.source !== 'claimed' &&
      siteIdentity(link.url) === claimed
  );
}
