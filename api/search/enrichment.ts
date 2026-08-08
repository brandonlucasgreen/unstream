// Shared enrichment functions for MusicBrainz data extraction
// These functions are used both by the MusicBrainz Netlify function and search-sources.ts

import { cacheGetOrFetch } from '../functions/cache';
import { isUrlHostnameAllowed } from '../functions/middleware';
import { findBandcampArtist } from './bandcamp-probe';

// Social platform types
export type SocialPlatform =
  | 'instagram' | 'facebook' | 'tiktok' | 'youtube'
  | 'threads' | 'bluesky'
  | 'mastodon' | 'peertube' | 'patreon' | 'kofi' | 'buymeacoffee';

export interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

// Discovered music platform types (found when scraping official websites)
export type DiscoveredPlatform = 'ampwall' | 'artcore' | 'nina' | 'subvert';

export interface DiscoveredPlatformLink {
  platform: DiscoveredPlatform;
  url: string;
}

export interface ArtistLocation {
  city?: string;
  country?: string;
  countryCode?: string;
}

// Known Mastodon/Fediverse instances (non-exhaustive, but covers popular ones)
const KNOWN_MASTODON_INSTANCES = [
  'mastodon.social', 'mastodon.online', 'mastodon.art', 'mastodon.world',
  'mstdn.social', 'mstdn.jp', 'fosstodon.org', 'hachyderm.io',
  'plush.city', 'tech.lgbt', 'wandering.shop', 'musician.social',
  'metalhead.club', 'social.coop', 'aus.social', 'infosec.exchange',
  'sfba.social', 'universeodon.com', 'c.im', 'toot.cafe',
];

// The hostname of a URL, or null when it isn't parseable as one.
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// True when the URL's host IS the instance (or a subdomain of it). Must compare
// hostnames, not substrings of the whole URL: the instance list contains short
// domains like "c.im", and a substring check matched it inside the URL-encoded
// query string of a Wix asset URL ("...%2C.imageEncoding..."), shipping that
// asset URL as an artist's "Mastodon profile".
function hostMatchesInstance(url: string, instances: string[]): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return instances.some(instance => host === instance || host.endsWith(`.${instance}`));
}

// Check if a URL belongs to a known Mastodon instance
export function isMastodonInstance(url: string): boolean {
  return hostMatchesInstance(url, KNOWN_MASTODON_INSTANCES);
}

// Known PeerTube instances (non-exhaustive, covers popular + music-focused ones)
const KNOWN_PEERTUBE_INSTANCES = [
  'tilvids.com', 'diode.zone', 'spectra.video', 'makertube.net',
  'tube.shanti.cafe', 'dalek.zone', 'videos.trom.tf', 'peertube.wtf',
  'peertube.stream', 'lostpod.space', 'fedi.video', 'videovortex.tv',
  'tube.anjara.eu', 'peertube.be', 'p.eertu.be', 'peertube.dk',
  'vod.newellijay.tv', 'video.mxtthxw.art', 'video.sorokin.music',
  'peertube.ignifi.me', 'clip.place', 'peerate.fr', 'gnulinux.tube',
  'tube.grin.hu', 'audio.freediverse.com',
  'communitymedia.video', 'tv.gravitons.org', 'fair.tube',
];

// Check if a URL belongs to a known PeerTube instance
export function isPeerTubeInstance(url: string): boolean {
  return hostMatchesInstance(url, KNOWN_PEERTUBE_INSTANCES);
}

// Convert a Mastodon handle (@user@server) to a URL
export function convertMastodonHandleToUrl(handle: string): string | null {
  // Handle formats: "@username@server.tld" or "username@server.tld"
  const match = handle.match(/@?([^@]+)@(.+)/);
  if (match) {
    return `https://${match[2]}/@${match[1]}`;
  }
  return null;
}

// Parse a URL to determine which social platform it belongs to
export function parseSocialUrl(url: string): SocialLink | null {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('instagram.com')) {
    return { platform: 'instagram', url };
  }
  if (urlLower.includes('facebook.com')) {
    return { platform: 'facebook', url };
  }
  if (urlLower.includes('tiktok.com')) {
    return { platform: 'tiktok', url };
  }
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
    return { platform: 'youtube', url };
  }
  if (urlLower.includes('threads.net') || urlLower.includes('threads.com')) {
    return { platform: 'threads', url };
  }
  if (urlLower.includes('bsky.app') || urlLower.includes('bluesky')) {
    return { platform: 'bluesky', url };
  }
  // Patronage platforms
  if (urlLower.includes('patreon.com')) {
    return { platform: 'patreon', url };
  }
  if (urlLower.includes('ko-fi.com')) {
    return { platform: 'kofi', url };
  }
  if (urlLower.includes('buymeacoffee.com')) {
    return { platform: 'buymeacoffee', url };
  }

  // Mastodon - check known instances (fediverse:creator meta tag handled separately)
  if (isMastodonInstance(urlLower)) {
    return { platform: 'mastodon', url };
  }

  // PeerTube - check known instances
  if (isPeerTubeInstance(urlLower)) {
    return { platform: 'peertube', url };
  }

  return null;
}

// Fetch a short bio summary from the Wikipedia REST API
export async function fetchWikipediaSummary(wikipediaUrl: string): Promise<{ extract: string; pageUrl: string } | null> {
  try {
    const match = wikipediaUrl.match(/\/wiki\/(.+)$/);
    if (!match) return null;
    const title = match[1];
    const response = await globalThis.fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      {
        headers: { 'User-Agent': 'Unstream/1.0 (https://unstream.stream)' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!response.ok) return null;
    const data = await response.json() as {
      type?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    if (data.type === 'disambiguation') return null;
    return {
      extract: data.extract || '',
      pageUrl: data.content_urls?.desktop?.page || wikipediaUrl,
    };
  } catch {
    return null;
  }
}

// Fetch and parse links from a Linktree page
export async function fetchLinktreeLinks(linktreeUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const seenPlatforms = new Set<SocialPlatform>();

  try {
    const response = await globalThis.fetch(linktreeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.log('Linktree fetch failed:', response.status);
      return socialLinks;
    }

    const html = await response.text();

    // Linktree uses data-testid="LinkButton" for link buttons
    // The actual URLs are in anchor tags with href attributes
    // Match pattern: <a ... href="https://..." ... data-testid="LinkButton" ...>
    // or: <a ... data-testid="LinkButton" ... href="https://..." ...>
    const linkMatches = html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi);

    for (const match of linkMatches) {
      const url = match[1];
      // Skip Linktree internal links and non-http URLs
      if (!url.startsWith('http') || url.includes('linktr.ee')) continue;

      const socialLink = parseSocialUrl(url);
      if (socialLink && !seenPlatforms.has(socialLink.platform)) {
        seenPlatforms.add(socialLink.platform);
        socialLinks.push(socialLink);
      }
    }

    console.log(`[Linktree] Found ${socialLinks.length} social links from ${linktreeUrl}`);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Linktree fetch error:', err.message);
  }

  return socialLinks;
}

// Extract Discogs artist ID from URL (e.g., https://www.discogs.com/artist/3840 -> 3840)
export function extractDiscogsArtistId(discogsUrl: string): string | null {
  const match = discogsUrl.match(/\/artist\/(\d+)/);
  return match ? match[1] : null;
}

// Fetch social links from Discogs API
export async function fetchDiscogsSocialLinks(discogsUrl: string): Promise<SocialLink[]> {
  const socialLinks: SocialLink[] = [];
  const artistId = extractDiscogsArtistId(discogsUrl);

  if (!artistId) return socialLinks;

  try {
    const response = await globalThis.fetch(`https://api.discogs.com/artists/${artistId}`, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://unstream.stream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('Discogs API failed:', response.status);
      return socialLinks;
    }

    const data = await response.json() as { urls?: string[] };
    const urls = data.urls || [];

    for (const url of urls) {
      const socialLink = parseSocialUrl(url);
      if (socialLink) {
        socialLinks.push(socialLink);
      }
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Discogs fetch error:', err.message);
  }

  return socialLinks;
}

// Result type for official site scraping (includes discovered Linktree URL and music platforms)
export interface OfficialSiteResult {
  socialLinks: SocialLink[];
  linktreeUrl: string | null;
  discoveredPlatforms: DiscoveredPlatformLink[];
}

// Fetch social links from an artist's official website
export async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<OfficialSiteResult> {
  const socialLinks: SocialLink[] = [];
  const seenPlatforms = new Set<SocialPlatform>();
  const discoveredPlatforms: DiscoveredPlatformLink[] = [];
  const seenDiscoveredPlatforms = new Set<DiscoveredPlatform>();
  let linktreeUrl: string | null = null;

  try {
    const response = await globalThis.fetch(officialUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.log('Official site fetch failed:', response.status);
      return { socialLinks, linktreeUrl, discoveredPlatforms };
    }

    const html = await response.text();

    // 1. Parse fediverse:creator meta tag for Mastodon (most reliable method)
    // Matches: <meta property="fediverse:creator" content="@user@server.tld">
    const fediverseMatch = html.match(/<meta\s+[^>]*property=["']fediverse:creator["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']fediverse:creator["']/i);
    if (fediverseMatch) {
      const handle = fediverseMatch[1];
      const mastodonUrl = convertMastodonHandleToUrl(handle);
      if (mastodonUrl && !seenPlatforms.has('mastodon')) {
        seenPlatforms.add('mastodon');
        socialLinks.push({ platform: 'mastodon', url: mastodonUrl });
      }
    }

    // 2. Parse rel="me" links (used for Mastodon verification)
    // Matches: <link rel="me" href="https://mastodon.social/@user">
    // Also matches <a rel="me" href="..."> which is common on personal sites
    const relMeMatches = html.matchAll(/<(?:link|a)\s+[^>]*rel=["']me["'][^>]*href=["']([^"']+)["']/gi);
    for (const match of relMeMatches) {
      const url = match[1];
      if (url.startsWith('http') && isMastodonInstance(url.toLowerCase()) && !seenPlatforms.has('mastodon')) {
        seenPlatforms.add('mastodon');
        socialLinks.push({ platform: 'mastodon', url });
        break; // Only need one Mastodon link
      }
    }

    // 3. Extract all href attributes from the page (existing logic, now with expanded platforms)
    const hrefMatches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of hrefMatches) {
      const url = match[1];
      // Skip relative URLs and non-http URLs
      if (!url.startsWith('http')) continue;

      // Check for Linktree URL (only capture first one found)
      if (url.includes('linktr.ee') && !linktreeUrl) {
        linktreeUrl = url;
        console.log(`[Official Site] Found Linktree: ${linktreeUrl}`);
        continue;
      }

      // Check for Ampwall artist page
      if (url.includes('ampwall.com') && !seenDiscoveredPlatforms.has('ampwall')) {
        seenDiscoveredPlatforms.add('ampwall');
        discoveredPlatforms.push({ platform: 'ampwall', url });
        console.log(`[Official Site] Found Ampwall: ${url}`);
        continue;
      }

      // Check for Artcore artist page
      if (url.includes('artcore.com') && !seenDiscoveredPlatforms.has('artcore')) {
        seenDiscoveredPlatforms.add('artcore');
        discoveredPlatforms.push({ platform: 'artcore', url });
        console.log(`[Official Site] Found Artcore: ${url}`);
        continue;
      }

      // Check for Nina Protocol profile page
      if (url.includes('ninaprotocol.com') && !seenDiscoveredPlatforms.has('nina')) {
        seenDiscoveredPlatforms.add('nina');
        discoveredPlatforms.push({ platform: 'nina', url });
        console.log(`[Official Site] Found Nina: ${url}`);
        continue;
      }

      // Check for Subvert artist page
      if (url.includes('subvert.fm') && !seenDiscoveredPlatforms.has('subvert')) {
        seenDiscoveredPlatforms.add('subvert');
        discoveredPlatforms.push({ platform: 'subvert', url });
        console.log(`[Official Site] Found Subvert: ${url}`);
        continue;
      }

      const socialLink = parseSocialUrl(url);
      // Only add one link per platform (first one wins)
      if (socialLink && !seenPlatforms.has(socialLink.platform)) {
        seenPlatforms.add(socialLink.platform);
        socialLinks.push(socialLink);
      }
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Official site fetch error:', err.message);
  }

  return { socialLinks, linktreeUrl, discoveredPlatforms };
}

// Merge social links from multiple sources, deduplicating by platform
export function mergeSocialLinks(...linkArrays: SocialLink[][]): SocialLink[] {
  const seenPlatforms = new Set<SocialPlatform>();
  const merged: SocialLink[] = [];

  for (const links of linkArrays) {
    for (const link of links) {
      if (!seenPlatforms.has(link.platform)) {
        seenPlatforms.add(link.platform);
        merged.push(link);
      }
    }
  }

  return merged;
}

// Search PeerTube via Sepia Search API for artist video channels
export async function searchPeerTubeChannels(artistName: string): Promise<SocialLink | null> {
  try {
    const searchUrl = `https://sepiasearch.org/api/v1/search/video-channels?search=${encodeURIComponent(artistName)}&count=5`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://unstream.stream - ethical music finder)',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.log('Sepia Search failed:', response.status);
      return null;
    }

    const data = await response.json() as {
      total: number;
      data: {
        name: string;
        displayName: string;
        host: string;
        url: string;
        videosCount: number;
        ownerAccount?: { name: string; displayName: string };
      }[];
    };

    if (!data.data || data.data.length === 0) return null;

    // Normalize artist name for matching
    const normalizedQuery = artistName.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Find a channel whose displayName or ownerAccount name closely matches the artist
    for (const channel of data.data) {
      // Skip channels with no videos
      if (channel.videosCount === 0) continue;

      const normalizedDisplay = channel.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedChannelName = channel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedOwner = channel.ownerAccount?.displayName?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      const normalizedOwnerName = channel.ownerAccount?.name?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';

      const isMatch =
        normalizedDisplay === normalizedQuery ||
        normalizedChannelName === normalizedQuery ||
        normalizedOwner === normalizedQuery ||
        normalizedOwnerName === normalizedQuery ||
        // Allow partial matches where one contains the other (for names like "Lime Bar Videos" matching "Lime Bar")
        (normalizedDisplay.includes(normalizedQuery) && normalizedQuery.length > normalizedDisplay.length * 0.5) ||
        (normalizedQuery.includes(normalizedDisplay) && normalizedDisplay.length > normalizedQuery.length * 0.5);

      if (isMatch) {
        console.log(`[Sepia Search] Found PeerTube channel on ${channel.host} (${channel.videosCount} videos)`);
        return { platform: 'peertube', url: channel.url };
      }
    }

    console.log(`[Sepia Search] No matching PeerTube channel (${data.total} total results)`);
    return null;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Sepia Search error:', err.message);
    return null;
  }
}

// Parse a raw location string that may be "City, Country" or just "Country".
// Returns an ArtistLocation with city and/or country split out.
export function parseLocationString(raw: string): ArtistLocation {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts.slice(0, -1).join(', '), country: parts[parts.length - 1] };
  }
  return { country: parts[0] };
}

// Merge location objects: fields from `primary` take precedence; missing fields filled from `fallback`.
export function mergeLocations(...sources: (ArtistLocation | null | undefined)[]): ArtistLocation | undefined {
  const result: ArtistLocation = {};
  for (const src of sources) {
    if (!src) continue;
    if (!result.city && src.city) result.city = src.city;
    if (!result.country && src.country) result.country = src.country;
    if (!result.countryCode && src.countryCode) result.countryCode = src.countryCode;
  }
  return (result.city || result.country) ? result : undefined;
}

/**
 * Whether a Bandcamp subdomain still hosts an account.
 *
 * `unknown` is a first-class answer, not a synonym for `live`. Callers must not
 * treat it as either verdict — see the tri-state rule in CLAUDE.md.
 */
export type BandcampSubdomainStatus = 'live' | 'dead' | 'unknown';

/** Retired subdomains stay retired; a live one rarely vanishes. Both are safe to hold for a week. */
const SUBDOMAIN_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Check whether a Bandcamp artist URL still resolves to a real account.
 *
 * A retired subdomain does not 404 — it answers `303` with
 * `Location: https://bandcamp.com/signup?new_domain=<slug>`, so an unchecked link
 * drops the fan on a signup form. MusicBrainz relations outlive the accounts they
 * point at, which is exactly how the Honeycrush report happened: MB still lists
 * `honeyyycrush.bandcamp.com`, retired some time ago.
 *
 * Only that one redirect counts as `dead`. A 200, any other redirect, a non-2xx, a
 * timeout or a network error all return `live`/`unknown` and leave the link alone —
 * a Bandcamp outage must degrade to "show the link anyway", never to stripping good
 * links off every result.
 *
 * One HEAD, no body: measured at ~200ms for a dead subdomain and ~300-450ms for a live
 * one. Verdicts are cached per URL (not per query) because this is a property of the
 * subdomain; `unknown` is deliberately never cached.
 */
export async function checkBandcampSubdomain(
  bandcampUrl: string,
  timeoutMs = 2500,
): Promise<BandcampSubdomainStatus> {
  if (!isUrlHostnameAllowed(bandcampUrl)) return 'unknown';

  const key = `bandcamp-subdomain:${bandcampUrl.replace(/\/+$/, '').toLowerCase()}`;
  const { data } = await cacheGetOrFetch<BandcampSubdomainStatus>(
    key,
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(bandcampUrl, {
          method: 'HEAD',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Unstream/1.0 (+https://unstream.stream)' },
        });
        const location = response.headers.get('location') ?? '';
        // The one signal that means "this account is gone".
        if (location.startsWith('https://bandcamp.com/signup')) return 'dead';
        // A 2xx, or a redirect to anywhere else on Bandcamp, means the account is there.
        if (response.ok) return 'live';
        if (response.status >= 300 && response.status < 400) return 'live';
        // 429, 5xx, bot challenge: Bandcamp did not answer the question we asked.
        return 'unknown';
      } catch {
        // Timeout or network error. We did not find out.
        return 'unknown';
      } finally {
        clearTimeout(timeout);
      }
    },
    SUBDOMAIN_STATUS_TTL_SECONDS,
    status => status !== 'unknown',
  );

  return data;
}

// Fetch location from a Bandcamp artist profile page.
// Validated against the SSRF allowlist as defense-in-depth.
// Default cap of 2.5s: this is one page fetch, measured at ~670ms, and it sits on a
// sequential path inside a function with a 10s ceiling.
export async function fetchBandcampLocation(bandcampUrl: string, timeoutMs = 2500): Promise<ArtistLocation | null> {
  if (!isUrlHostnameAllowed(bandcampUrl)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await globalThis.fetch(bandcampUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();

    // Iterate all JSON-LD blocks; find the MusicGroup entry which carries the artist location
    const jsonLdPattern = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
    let jsonLdMatch: RegExpExecArray | null;
    while ((jsonLdMatch = jsonLdPattern.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(jsonLdMatch[1]);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (entry?.['@type'] === 'MusicGroup') {
            const raw = entry?.foundingLocation?.name || entry?.location?.name;
            if (raw) return parseLocationString(raw);
          }
        }
      } catch { /* skip malformed blocks */ }
    }

    // Fall back to location element in artist header (Bandcamp uses <p class="location ...">)
    const locationMatch = html.match(/<(?:p|div|span)[^>]+class="[^"]*\blocation\b[^"]*"[^>]*>([^<]+)<\/(?:p|div|span)>/);
    if (locationMatch) return parseLocationString(locationMatch[1].trim());

    return null;
  } catch {
    return null;
  }
}

// Spike: fetch artist location from Mirlo REST API.
// Constructs URL internally from artist slug — no user input involved.
export async function fetchMirloLocation(artistSlug: string, timeoutMs = 4000): Promise<ArtistLocation | null> {
  if (!artistSlug) return null;
  try {
    // Must be the by-slug endpoint. The list form (`/v1/artists?urlSlug=…`) silently
    // IGNORES the filter and returns the first page of all artists, so reading
    // results[0] handed every artist on the site the same location — "Holyoke, MA",
    // whoever happens to be first. This endpoint 404s when the artist isn't on Mirlo.
    const apiUrl = `https://api.mirlo.space/v1/artists/${encodeURIComponent(artistSlug)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await globalThis.fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Unstream/1.0 (https://unstream.stream)' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json() as { result?: { urlSlug?: string; location?: string } };
    // Belt and braces: only trust the location if the slug really came back to us.
    if (!data.result || data.result.urlSlug !== artistSlug) return null;
    const raw = data.result.location;
    if (raw) return parseLocationString(raw);
    return null;
  } catch {
    return null;
  }
}

// Fallback enrichment when MusicBrainz has no match: look up location via Bandcamp and Mirlo.
// Both run in parallel with a 3s cap, so this adds at most ~3s to Phase 2 — the Bandcamp
// side used to be two sequential requests, but the probe now reads location out of the
// /music page it already fetched.
export async function enrichLocationFallback(query: string): Promise<ArtistLocation | undefined> {
  const mirloSlug = query.toLowerCase().replace(/\s+/g, '');
  const FALLBACK_TIMEOUT = 3000;

  const [bandcampMatch, mirloLocation] = await Promise.all([
    findBandcampArtist(query, FALLBACK_TIMEOUT),
    fetchMirloLocation(mirloSlug, FALLBACK_TIMEOUT),
  ]);

  const bandcampLocation = bandcampMatch?.location
    ? parseLocationString(bandcampMatch.location)
    : null;

  return mergeLocations(bandcampLocation, mirloLocation);
}
