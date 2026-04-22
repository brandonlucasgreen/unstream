// Social platform types
type SocialPlatform =
  | 'instagram' | 'facebook' | 'tiktok' | 'youtube'
  | 'threads' | 'bluesky'
  | 'mastodon' | 'peertube' | 'patreon' | 'kofi' | 'buymeacoffee';

interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

// Discovered music platform types (found when scraping official websites)
type DiscoveredPlatform = 'ampwall' | 'artcore' | 'nina';

interface DiscoveredPlatformLink {
  platform: DiscoveredPlatform;
  url: string;
}

interface ArtistLocation {
  city?: string;
  country?: string;
  countryCode?: string;
}

// MusicBrainz search response for lazy loading
interface MusicBrainzSearchResponse {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
  discoveredPlatforms: DiscoveredPlatformLink[];
  platformUrls: string[]; // Known platform URLs from MusicBrainz relations (bandcamp, mirlo, etc.)
  wikipediaSummary: string | null;
  wikipediaUrl: string | null;
  location?: ArtistLocation;
}

// Known Mastodon/Fediverse instances (non-exhaustive, but covers popular ones)
const KNOWN_MASTODON_INSTANCES = [
  'mastodon.social', 'mastodon.online', 'mastodon.art', 'mastodon.world',
  'mstdn.social', 'mstdn.jp', 'fosstodon.org', 'hachyderm.io',
  'plush.city', 'tech.lgbt', 'wandering.shop', 'musician.social',
  'metalhead.club', 'social.coop', 'aus.social', 'infosec.exchange',
  'sfba.social', 'universeodon.com', 'c.im', 'toot.cafe',
];

// Check if a URL belongs to a known Mastodon instance
function isMastodonInstance(urlLower: string): boolean {
  return KNOWN_MASTODON_INSTANCES.some(instance => urlLower.includes(instance));
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
function isPeerTubeInstance(urlLower: string): boolean {
  return KNOWN_PEERTUBE_INSTANCES.some(instance => urlLower.includes(instance));
}

// Convert a Mastodon handle (@user@server) to a URL
function convertMastodonHandleToUrl(handle: string): string | null {
  // Handle formats: "@username@server.tld" or "username@server.tld"
  const match = handle.match(/@?([^@]+)@(.+)/);
  if (match) {
    return `https://${match[2]}/@${match[1]}`;
  }
  return null;
}

// Parse a URL to determine which social platform it belongs to
function parseSocialUrl(url: string): SocialLink | null {
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
async function fetchWikipediaSummary(wikipediaUrl: string): Promise<{ extract: string; pageUrl: string } | null> {
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

import { cacheGetOrFetch, artistCacheKey } from './cache';
import { persistEnrichment } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { validateQuery, isUrlHostnameAllowed } from './middleware';

// Cache TTL for MusicBrainz lookups (30 minutes)
const MUSICBRAINZ_CACHE_TTL = 30 * 60;

// Normalize accented characters to their ASCII equivalents
// e.g., "Tanerélle" -> "Tanerelle", "Björk" -> "Bjork"
function normalizeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normalize a search query for API calls
function normalizeSearchQuery(query: string): string {
  return normalizeAccents(query);
}

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch and parse links from a Linktree page
async function fetchLinktreeLinks(linktreeUrl: string): Promise<SocialLink[]> {
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
function extractDiscogsArtistId(discogsUrl: string): string | null {
  const match = discogsUrl.match(/\/artist\/(\d+)/);
  return match ? match[1] : null;
}

// Fetch social links from Discogs API
async function fetchDiscogsSocialLinks(discogsUrl: string): Promise<SocialLink[]> {
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
interface OfficialSiteResult {
  socialLinks: SocialLink[];
  linktreeUrl: string | null;
  discoveredPlatforms: DiscoveredPlatformLink[];
}

// Fetch social links from an artist's official website
async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<OfficialSiteResult> {
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
function mergeSocialLinks(...linkArrays: SocialLink[][]): SocialLink[] {
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
async function searchPeerTubeChannels(artistName: string): Promise<SocialLink | null> {
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
        console.log(`[Sepia Search] Found PeerTube channel for "${artistName}": ${channel.displayName} on ${channel.host} (${channel.videosCount} videos)`);
        return { platform: 'peertube', url: channel.url };
      }
    }

    console.log(`[Sepia Search] No matching PeerTube channel for "${artistName}" (${data.total} total results)`);
    return null;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Sepia Search error:', err.message);
    return null;
  }
}

// Parse a raw location string that may be "City, Country" or just "Country".
// Returns an ArtistLocation with city and/or country split out.
function parseLocationString(raw: string): ArtistLocation {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts.slice(0, -1).join(', '), country: parts[parts.length - 1] };
  }
  return { country: parts[0] };
}

// Merge location objects: fields from `primary` take precedence; missing fields filled from `fallback`.
function mergeLocations(...sources: (ArtistLocation | null | undefined)[]): ArtistLocation | undefined {
  const result: ArtistLocation = {};
  for (const src of sources) {
    if (!src) continue;
    if (!result.city && src.city) result.city = src.city;
    if (!result.country && src.country) result.country = src.country;
    if (!result.countryCode && src.countryCode) result.countryCode = src.countryCode;
  }
  return (result.city || result.country) ? result : undefined;
}

// Search Bandcamp for an artist by name and return the first matching artist/label URL.
// Mirrors the Phase 1 Bandcamp scrape but runs server-side within Phase 2 enrichment,
// so no client-supplied URLs are involved.
async function searchBandcampForArtistUrl(artistName: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const searchUrl = `https://bandcamp.com/search?q=${encodeURIComponent(artistName)}&item_type=b`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await globalThis.fetch(searchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();

    // Parse the first artist/label result whose name closely matches the query
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedQuery = normalize(artistName);

    // Match searchresult blocks: extract itemtype, URL, and display name
    const blockPattern = /<li[^>]+class="[^"]*searchresult[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    let block: RegExpExecArray | null;
    while ((block = blockPattern.exec(html)) !== null) {
      const blockHtml = block[1];
      const typeMatch = blockHtml.match(/class="[^"]*itemtype[^"]*"[^>]*>\s*([^<]+)\s*</);
      const linkMatch = blockHtml.match(/class="[^"]*heading[^"]*"[^>]*>\s*<a[^>]+href="([^"?]+)/);
      const nameMatch = blockHtml.match(/class="[^"]*heading[^"]*"[^>]*>\s*<a[^>]*>([^<]+)</);
      if (!typeMatch || !linkMatch || !nameMatch) continue;

      const itemType = typeMatch[1].trim().toLowerCase();
      if (itemType !== 'artist' && itemType !== 'label') continue;

      const name = nameMatch[1].trim();
      const url = linkMatch[1];
      const normalizedName = normalize(name);

      // Accept if names are equal or one contains the other (handles minor punctuation differences)
      if (normalizedName === normalizedQuery ||
          normalizedName.includes(normalizedQuery) ||
          normalizedQuery.includes(normalizedName)) {
        return url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch location from a Bandcamp artist profile page.
// Validated against the SSRF allowlist as defense-in-depth.
async function fetchBandcampLocation(bandcampUrl: string, timeoutMs = 4000): Promise<ArtistLocation | null> {
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
async function fetchMirloLocation(artistSlug: string, timeoutMs = 4000): Promise<ArtistLocation | null> {
  if (!artistSlug) return null;
  try {
    const apiUrl = `https://api.mirlo.space/v1/artists?urlSlug=${encodeURIComponent(artistSlug)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await globalThis.fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Unstream/1.0 (https://unstream.stream)' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json() as { results?: { location?: string }[] };
    const raw = data.results?.[0]?.location;
    if (raw) return parseLocationString(raw);
    return null;
  } catch {
    return null;
  }
}

// Fallback enrichment when MusicBrainz has no match: look up location via Bandcamp and Mirlo.
// Uses shorter timeouts (3s each) so the total adds at most ~6s to the Phase 2 response time.
async function enrichLocationFallback(query: string): Promise<ArtistLocation | undefined> {
  const mirloSlug = query.toLowerCase().replace(/\s+/g, '');
  const FALLBACK_TIMEOUT = 3000;

  const bandcampUrl = await searchBandcampForArtistUrl(query, FALLBACK_TIMEOUT);
  const [bandcampLocation, mirloLocation] = await Promise.all([
    bandcampUrl ? fetchBandcampLocation(bandcampUrl, FALLBACK_TIMEOUT) : Promise.resolve(null),
    fetchMirloLocation(mirloSlug, FALLBACK_TIMEOUT),
  ]);

  return mergeLocations(bandcampLocation, mirloLocation);
}

// Search MusicBrainz for artist info including official website, Discogs, social links, and release history
async function searchMusicBrainz(query: string): Promise<MusicBrainzSearchResponse> {
  const emptyResult: MusicBrainzSearchResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
    discoveredPlatforms: [],
    platformUrls: [],
    wikipediaSummary: null,
    wikipediaUrl: null,
    location: undefined,
  };

  try {
    // Search for artist
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return emptyResult;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) {
      console.log(`[MusicBrainz] No results for "${query}", falling back to Bandcamp/Mirlo location`);
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) {
      console.log(`[MusicBrainz] Low confidence match for "${query}" (score ${artist.score}), falling back to Bandcamp/Mirlo location`);
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    // Verify the returned artist name actually matches the query
    // This prevents "Synthetic Ruby" from matching just "Ruby"
    const queryNormalized = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const artistNormalized = artist.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isNameMatch = queryNormalized === artistNormalized ||
      queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7 ||
      artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7;

    if (!isNameMatch) {
      console.log(`[MusicBrainz] Skipping "${artist.name}" - doesn't match query "${query}", falling back to Bandcamp/Mirlo location`);
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await delay(1100);

    // Fetch artist details with URL relations
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let officialUrl: string | null = null;
    let discogsUrl: string | null = null;
    let linktreeUrl: string | null = null;
    let wikipediaUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();
    const platformUrls: string[] = [];

    let mbLocation: ArtistLocation | undefined;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: { type: string; url?: { resource: string } }[];
        // Top-level ISO 3166-1 alpha-2 country code (e.g. "US"), separate from area
        country?: string;
        area?: { name: string; type?: string | null; 'iso-3166-1-codes'?: string[] };
        'begin-area'?: { name: string; type?: string | null };
      };

      // Parse location from area / begin-area fields.
      // MB area types: 'Country', 'Subdivision', 'City', 'Municipality', 'District', 'Island'.
      // Critically: type is often null for community-entered data — treat null-type areas as
      // cities/regions (the most common case) rather than silently dropping them.
      // The top-level `country` field (ISO 3166-1 alpha-2) is read separately for countryCode.
      const topLevelCountryCode = artistData.country;
      const cityTypes = new Set(['City', 'Municipality', 'District', 'Subdivision', 'Island']);
      if (artistData.area) {
        if (artistData.area.type === 'Country') {
          mbLocation = {
            country: artistData.area.name,
            countryCode: artistData.area['iso-3166-1-codes']?.[0] ?? topLevelCountryCode,
          };
        } else {
          // Null type or explicit sub-country type — treat as city/region.
          // Attach the top-level country code so we have it for display context.
          mbLocation = {
            city: artistData.area.name,
            countryCode: topLevelCountryCode,
          };
        }
      } else if (topLevelCountryCode) {
        // No area at all, but MB still gives us a country code
        mbLocation = { countryCode: topLevelCountryCode };
      }
      if (artistData['begin-area'] && artistData['begin-area'].name !== artistData.area?.name) {
        const beginType = artistData['begin-area'].type;
        if (beginType === 'Country' && !mbLocation?.country) {
          mbLocation = { ...mbLocation, country: artistData['begin-area'].name };
        } else if (beginType !== 'Country') {
          // null type or city/subdivision — use as city (more specific than area)
          mbLocation = { ...mbLocation, city: artistData['begin-area'].name };
        }
      }

      const relations = artistData.relations || [];

      // Look for official homepage
      for (const rel of relations) {
        if (rel.type === 'official homepage' && rel.url?.resource) {
          officialUrl = rel.url.resource;
          break;
        }
      }

      // Look for Discogs link
      for (const rel of relations) {
        if (rel.type === 'discogs' && rel.url?.resource) {
          discogsUrl = rel.url.resource;
          break;
        }
      }

      // Look for English Wikipedia link
      for (const rel of relations) {
        if (rel.type === 'wikipedia' && rel.url?.resource && rel.url.resource.includes('en.wikipedia.org')) {
          wikipediaUrl = rel.url.resource;
          break;
        }
      }

      // Extract social links from 'social network' and 'youtube' relation types
      // Also capture Linktree URLs for later scraping
      for (const rel of relations) {
        if ((rel.type === 'social network' || rel.type === 'youtube') && rel.url?.resource) {
          const url = rel.url.resource;

          // Check for Linktree URL
          if (url.includes('linktr.ee') && !linktreeUrl) {
            linktreeUrl = url;
            console.log(`[MusicBrainz] Found Linktree: ${linktreeUrl}`);
            continue;
          }

          const socialLink = parseSocialUrl(url);
          // Only add one link per platform (first one wins)
          if (socialLink && !seenPlatforms.has(socialLink.platform)) {
            seenPlatforms.add(socialLink.platform);
            socialLinks.push(socialLink);
          }
        }
      }

      // Extract known music platform URLs from relations for disambiguation.
      // These let us match MusicBrainz data to the correct search result
      // when multiple same-name artists exist.
      const platformRelTypes = new Set([
        'bandcamp', 'streaming music', 'purchase for download',
        'download for free', 'free streaming',
      ]);
      for (const rel of relations) {
        if (rel.url?.resource && platformRelTypes.has(rel.type)) {
          platformUrls.push(rel.url.resource);
        }
      }
      if (platformUrls.length > 0) {
        console.log(`[MusicBrainz] Found ${platformUrls.length} platform URLs: ${platformUrls.join(', ')}`);
      }
    }

    // Wait again before next request
    await delay(1100);

    // Check if artist has pre-2005 releases (for Hoopla/Freegal eligibility)
    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let hasPre2005Release = false;

    if (releasesResponse.ok) {
      const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
      const releaseGroups = releasesData['release-groups'] || [];

      for (const rg of releaseGroups) {
        const firstReleaseDate = rg['first-release-date'];
        if (firstReleaseDate) {
          const year = parseInt(firstReleaseDate.substring(0, 4), 10);
          if (year < 2005) {
            hasPre2005Release = true;
            break;
          }
        }
      }
    }

    // Derive Bandcamp URL from MB's own platform relations if available (most authoritative).
    // Falls back to a live Bandcamp search by the MB-confirmed artist name so we always
    // try to find location even when MB's Bandcamp link is absent or stale.
    const mbBandcampUrl = platformUrls.find(u => {
      try { return new URL(u).hostname.endsWith('.bandcamp.com'); } catch { return false; }
    });
    const mirloSlug = artist.name.toLowerCase().replace(/\s+/g, '');

    // Fetch additional social links from Discogs, official site, PeerTube, Wikipedia,
    // and platform locations (Bandcamp, Mirlo) in parallel.
    // Bandcamp location: prefers MB relation URL; falls back to live Bandcamp search by name.
    const [discogsSocialLinks, officialSiteResult, peertubeLink, wikipediaResult, bandcampLocation, mirloLocation] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null, discoveredPlatforms: [] }),
      searchPeerTubeChannels(artist.name),
      wikipediaUrl ? fetchWikipediaSummary(wikipediaUrl) : Promise.resolve(null),
      (async () => {
        // Try MB relation URL first; if absent or returns no location, search Bandcamp directly
        if (mbBandcampUrl) {
          const loc = await fetchBandcampLocation(mbBandcampUrl);
          if (loc) return loc;
        }
        const searchedUrl = await searchBandcampForArtistUrl(artist.name);
        return searchedUrl ? fetchBandcampLocation(searchedUrl) : null;
      })(),
      fetchMirloLocation(mirloSlug),
    ]);

    // Merge locations: MusicBrainz is authoritative; Bandcamp and Mirlo fill in missing fields
    const location = mergeLocations(mbLocation, bandcampLocation, mirloLocation);

    // If we found a Linktree URL from MusicBrainz or official site, scrape it for additional links
    // Prefer MusicBrainz Linktree (more authoritative), fall back to official site
    const finalLinktreeUrl = linktreeUrl || officialSiteResult.linktreeUrl;
    let linktreeSocialLinks: SocialLink[] = [];
    if (finalLinktreeUrl) {
      linktreeSocialLinks = await fetchLinktreeLinks(finalLinktreeUrl);
    }

    // Collect PeerTube link from Sepia Search (if not already found via other sources)
    const peertubeLinks: SocialLink[] = peertubeLink ? [peertubeLink] : [];

    // Merge all social links (MusicBrainz first, then Discogs, then official site, then Linktree, then PeerTube)
    // PeerTube from Sepia Search comes last so official site / Linktree links take priority
    const allSocialLinks = mergeSocialLinks(socialLinks, discogsSocialLinks, officialSiteResult.socialLinks, linktreeSocialLinks, peertubeLinks);

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
      discoveredPlatforms: officialSiteResult.discoveredPlatforms,
      platformUrls,
      wikipediaSummary: wikipediaResult?.extract || null,
      wikipediaUrl: wikipediaResult?.pageUrl || wikipediaUrl,
      location,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return emptyResult;
  }
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'strict', corsHeaders);
  if (rl.limited) return rl.response;

  const queryResult = validateQuery(event.queryStringParameters?.query);
  if ('error' in queryResult) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: queryResult.error }),
    };
  }
  const query = queryResult.query;

  try {
    // Normalize the query to handle accented characters (e.g., "Tanerélle" -> "Tanerelle")
    const normalizedQuery = normalizeSearchQuery(query);

    // Use Redis cache to avoid hitting MusicBrainz rate limits
    const cacheKey = artistCacheKey('musicbrainz', normalizedQuery);
    const { data: result, cached } = await cacheGetOrFetch<MusicBrainzSearchResponse>(
      cacheKey,
      () => searchMusicBrainz(normalizedQuery),
      MUSICBRAINZ_CACHE_TTL
    );

    if (cached) {
      console.log(`[MusicBrainz] Cache hit for "${normalizedQuery}"`);
    }

    // Persist enrichment to the artist database
    if (result.artistName) {
      try {
        await persistEnrichment(result.artistName, result);
      } catch (err) {
        console.error('[DB] Background enrichment persist failed:', err);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error('MusicBrainz endpoint error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
        socialLinks: [],
        discoveredPlatforms: [],
        wikipediaSummary: null,
        wikipediaUrl: null,
      }),
    };
  }
}
