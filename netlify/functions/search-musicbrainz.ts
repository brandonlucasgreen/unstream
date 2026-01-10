// Social platform types
type SocialPlatform =
  | 'instagram' | 'facebook' | 'tiktok' | 'youtube'
  | 'threads' | 'bluesky' | 'twitter'
  | 'mastodon' | 'patreon' | 'kofi' | 'buymeacoffee';

interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

// MusicBrainz search response for lazy loading
interface MusicBrainzSearchResponse {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
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
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) {
    return { platform: 'twitter', url };
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

  return null;
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

// Result type for official site scraping (includes discovered Linktree URL)
interface OfficialSiteResult {
  socialLinks: SocialLink[];
  linktreeUrl: string | null;
}

// Fetch social links from an artist's official website
async function fetchOfficialSiteSocialLinks(officialUrl: string): Promise<OfficialSiteResult> {
  const socialLinks: SocialLink[] = [];
  const seenPlatforms = new Set<SocialPlatform>();
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
      return { socialLinks, linktreeUrl };
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

  return { socialLinks, linktreeUrl };
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

// Search MusicBrainz for artist info including official website, Discogs, social links, and release history
async function searchMusicBrainz(query: string): Promise<MusicBrainzSearchResponse> {
  const emptyResult: MusicBrainzSearchResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
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

    if (artists.length === 0) return emptyResult;

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) return emptyResult;

    // Verify the returned artist name actually matches the query
    // This prevents "Synthetic Ruby" from matching just "Ruby"
    const queryNormalized = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const artistNormalized = artist.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isNameMatch = queryNormalized === artistNormalized ||
      queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7 ||
      artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7;

    if (!isNameMatch) {
      console.log(`[MusicBrainz] Skipping "${artist.name}" - doesn't match query "${query}"`);
      return emptyResult;
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
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: {
          type: string;
          url?: { resource: string };
        }[];
      };

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

    // Fetch additional social links from Discogs and official site in parallel
    const [discogsSocialLinks, officialSiteResult] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null }),
    ]);

    // If we found a Linktree URL from MusicBrainz or official site, scrape it for additional links
    // Prefer MusicBrainz Linktree (more authoritative), fall back to official site
    const finalLinktreeUrl = linktreeUrl || officialSiteResult.linktreeUrl;
    let linktreeSocialLinks: SocialLink[] = [];
    if (finalLinktreeUrl) {
      linktreeSocialLinks = await fetchLinktreeLinks(finalLinktreeUrl);
    }

    // Merge all social links (MusicBrainz first, then Discogs, then official site, then Linktree)
    const allSocialLinks = mergeSocialLinks(socialLinks, discogsSocialLinks, officialSiteResult.socialLinks, linktreeSocialLinks);

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return emptyResult;
  }
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const query = event.queryStringParameters?.query;

  if (!query) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Query parameter is required' }),
    };
  }

  try {
    const result = await searchMusicBrainz(query);

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
      }),
    };
  }
}
