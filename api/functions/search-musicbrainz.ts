// MusicBrainz enrichment server function
// Imports shared functions from enrichment.ts, keeps Netlify handler here

import { cacheGetOrFetch } from './cache';
import { persistEnrichment } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { validateQuery, isUrlHostnameAllowed } from './middleware';
import { normalizeAccents, normalizeSearchQuery } from './search-utils';

// Import all shared enrichment functions and types
import {
  SocialPlatform,
  SocialLink,
  DiscoveredPlatform,
  DiscoveredPlatformLink,
  ArtistLocation,
  isMastodonInstance,
  isPeerTubeInstance,
  convertMastodonHandleToUrl,
  parseSocialUrl,
  fetchWikipediaSummary,
  fetchLinktreeLinks,
  extractDiscogsArtistId,
  fetchDiscogsSocialLinks,
  OfficialSiteResult,
  fetchOfficialSiteSocialLinks,
  mergeSocialLinks,
  searchPeerTubeChannels,
  parseLocationString,
  mergeLocations,
  searchBandcampForArtistUrl,
  fetchBandcampLocation,
  fetchMirloLocation,
  enrichLocationFallback,
} from '../search/enrichment';

// Cache TTL for MusicBrainz lookups (30 minutes)
const MUSICBRAINZ_CACHE_TTL = 30 * 60;

// MusicBrainz search response for the API
interface MusicBrainzSearchResponse {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
  discoveredPlatforms: DiscoveredPlatformLink[];
  platformUrls: string[];
  wikipediaSummary: string | null;
  wikipediaUrl: string | null;
  location?: ArtistLocation;
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
    await new Promise(resolve => setTimeout(resolve, 1100));

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
    await new Promise(resolve => setTimeout(resolve, 1100));

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

    // Persist enrichment to the artist database.
    // Also persist on MB-miss if we at least captured location (from the
    // Bandcamp/Mirlo fallback), keyed on the normalized query's slug.
    const persistName = result.artistName || (result.location ? normalizedQuery : null);
    if (persistName) {
      try {
        await persistEnrichment(persistName, result);
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
