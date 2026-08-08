// MusicBrainz enrichment server function
// Imports shared functions from enrichment.ts, keeps Netlify handler here

import { Sentry } from '../lib/sentry';
import { cacheGetOrFetch, artistCacheKey } from './cache';
import { persistEnrichment, getLinkSuppressions } from './db';
import { checkRateLimit, checkSentryDedup, getClientIp } from './ratelimit';
import { validateQuery, isUrlHostnameAllowed } from './middleware';
import { normalizeAccents, normalizeForComparison, normalizeSearchQuery, musicBrainzArtistQuery, isUrlSuppressed, type LinkSuppression } from './search-utils';

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
  fetchBandcampLocation,
  checkBandcampSubdomain,
  fetchMirloLocation,
  enrichLocationFallback,
} from '../search/enrichment';
import { findBandcampArtist } from '../search/bandcamp-probe';

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

// Search MusicBrainz for artist info including official website, Discogs, social links, and release history.
//
// Returns null when MusicBrainz itself did not answer (non-2xx). That is deliberately
// distinct from "MusicBrainz has no such artist", which returns a populated empty
// result: the caller must not cache the former. Caching an upstream failure turned a
// single MusicBrainz hiccup into 30 minutes of "this artist has no links" for that
// query — the same mistake as reading a bot-challenge page as "not on Bandcamp".
async function searchMusicBrainz(query: string): Promise<MusicBrainzSearchResponse | null> {
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
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(musicBrainzArtistQuery(query))}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      // Upstream did not answer — signal "unknown" so this is not cached.
      console.log('MusicBrainz artist search failed:', response.status);
      return null;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) {
      console.log('[MusicBrainz] No results, falling back to Bandcamp/Mirlo location');
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) {
      console.log(`[MusicBrainz] Low confidence match (score ${artist.score}), falling back to Bandcamp/Mirlo location`);
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    // Verify the returned artist name actually matches the query
    // This prevents "Synthetic Ruby" from matching just "Ruby"
    //
    // Must use normalizeForComparison, which strips accents. A bare
    // .replace(/[^a-z0-9]/g, '') *deletes* accented letters instead: MusicBrainz returns
    // "Tanerélle" -> "tanerlle" while the query arrives already accent-normalized as
    // "Tanerelle" -> "tanerelle", so every accented artist name failed this check and
    // lost all MB enrichment.
    const queryNormalized = normalizeForComparison(query);
    const artistNormalized = normalizeForComparison(artist.name);
    const isNameMatch = queryNormalized === artistNormalized ||
      queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7 ||
      artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7;

    if (!isNameMatch) {
      console.log('[MusicBrainz] Top match does not match the query, falling back to Bandcamp/Mirlo location');
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Fetch URL relations AND release groups in a single lookup. These used to be two
    // requests with a mandatory 1.1s gap between them; `inc=url-rels+release-groups`
    // returns both, saving a round trip plus the gap (~1.6s measured). The release
    // groups carry `first-release-date`, which is all the pre-2005 check needs.
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels+release-groups&fmt=json`;

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
    let platformUrls: string[] = [];

    let mbLocation: ArtistLocation | undefined;
    let hasPre2005Release = false;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: { type: string; url?: { resource: string } }[];
        // Top-level ISO 3166-1 alpha-2 country code (e.g. "US"), separate from area
        country?: string;
        area?: { name: string; type?: string | null; 'iso-3166-1-codes'?: string[] };
        'begin-area'?: { name: string; type?: string | null };
        // Present because of inc=release-groups; feeds the pre-2005 check below.
        'release-groups'?: { 'first-release-date'?: string }[];
      };

      // Hoopla/Freegal eligibility: any release group first issued before 2005.
      for (const rg of artistData['release-groups'] || []) {
        const firstReleaseDate = rg['first-release-date'];
        if (!firstReleaseDate) continue;
        if (parseInt(firstReleaseDate.substring(0, 4), 10) < 2005) {
          hasPre2005Release = true;
          break;
        }
      }

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

    // Derive Bandcamp URL from MB's own platform relations if available (most authoritative).
    // Falls back to a live Bandcamp search by the MB-confirmed artist name so we always
    // try to find location even when MB's Bandcamp link is absent or stale.
    const mbBandcampUrl = platformUrls.find(u => {
      try { return new URL(u).hostname.endsWith('.bandcamp.com'); } catch { return false; }
    });
    const mbSubvertUrl = platformUrls.find(u => {
      try { return new URL(u).hostname === 'www.subvert.fm' || new URL(u).hostname === 'subvert.fm'; } catch { return false; }
    });
    const mirloSlug = artist.name.toLowerCase().replace(/\s+/g, '');

    // Fetch additional social links from Discogs, official site, PeerTube, Wikipedia,
    // and platform locations (Bandcamp, Mirlo) in parallel.
    // Bandcamp location: prefers MB relation URL; falls back to live Bandcamp search by name.
    const [discogsSocialLinks, officialSiteResult, peertubeLink, wikipediaResult, bandcampLocation, mirloLocation, bandcampStatus] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null, discoveredPlatforms: [] }),
      searchPeerTubeChannels(artist.name),
      wikipediaUrl ? fetchWikipediaSummary(wikipediaUrl) : Promise.resolve(null),
      (async () => {
        // Prefer MusicBrainz's own relation URL, then fall back to the probe.
        // The probe reads location out of the /music page it already fetched, so this
        // is at most two sequential requests rather than three — the third fetch used
        // to push the worst case past the function's 10s ceiling.
        if (mbBandcampUrl) {
          const loc = await fetchBandcampLocation(mbBandcampUrl);
          if (loc) return loc;
        }
        const match = await findBandcampArtist(artist.name, 2500);
        return match?.location ? parseLocationString(match.location) : null;
      })(),
      fetchMirloLocation(mirloSlug),
      mbBandcampUrl ? checkBandcampSubdomain(mbBandcampUrl) : Promise.resolve('unknown' as const),
    ]);

    // Phase 1 strips retired subdomains at the same point; this is the Phase 2 path the
    // client falls back to when server-side enrichment didn't land in time. Both have to
    // do it, or the dead link simply arrives a second later. Only a confirmed 'dead' is
    // dropped — 'unknown' keeps trusting MB, so a Bandcamp outage changes nothing.
    if (mbBandcampUrl && bandcampStatus === 'dead') {
      console.log(`[MusicBrainz] Dropping retired Bandcamp subdomain for "${artist.name}": ${mbBandcampUrl}`);
      platformUrls = platformUrls.filter(u => u !== mbBandcampUrl);
    }

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

    // Merge discovered platforms from official site + MusicBrainz Subvert URL
    const allDiscoveredPlatforms = [...officialSiteResult.discoveredPlatforms];
    if (mbSubvertUrl && !allDiscoveredPlatforms.some(p => p.platform === 'subvert')) {
      allDiscoveredPlatforms.push({ platform: 'subvert', url: mbSubvertUrl });
    }

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
      discoveredPlatforms: allDiscoveredPlatforms,
      platformUrls,
      wikipediaSummary: wikipediaResult?.extract || null,
      wikipediaUrl: wikipediaResult?.pageUrl || wikipediaUrl,
      location,
    };
  } catch (error: unknown) {
    // A network error or timeout is also "we don't know" rather than "no such artist",
    // so it must not be cached either.
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return null;
  }
}

/** Response shape used when MusicBrainz did not answer. Nothing is cached for it. */
function unavailableResult(query: string): MusicBrainzSearchResponse {
  return {
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
}

/**
 * Drop links an admin has suppressed for this artist.
 *
 * Applied to the response *after* the cache read, never inside the cached
 * function: a suppression added today must take effect on the next request
 * rather than waiting out a 30-minute cache entry. Phase 1 does the same at the
 * end of its own pipeline (applyLinkSuppressions), but this endpoint's links are
 * merged into the results client-side, so they need their own pass — otherwise a
 * removed link reappears the moment enrichment lands.
 */
function stripSuppressedLinks(
  result: MusicBrainzSearchResponse,
  suppressions: LinkSuppression[],
): MusicBrainzSearchResponse {
  if (suppressions.length === 0 || !result.artistName) return result;

  const artistName = result.artistName;
  const suppressed = (url: string) => isUrlSuppressed(url, artistName, suppressions);

  return {
    ...result,
    officialUrl: result.officialUrl && suppressed(result.officialUrl) ? null : result.officialUrl,
    discogsUrl: result.discogsUrl && suppressed(result.discogsUrl) ? null : result.discogsUrl,
    socialLinks: result.socialLinks.filter(s => !suppressed(s.url)),
    discoveredPlatforms: result.discoveredPlatforms.filter(p => !suppressed(p.url)),
    platformUrls: result.platformUrls.filter(u => !suppressed(u)),
  };
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

    // Rides along with the MusicBrainz round-trips below instead of adding a
    // serial hop. getLinkSuppressions catches its own errors ([] on failure).
    const suppressionsPromise = getLinkSuppressions();

    // Use Redis cache to avoid hitting MusicBrainz rate limits
    const cacheKey = artistCacheKey('musicbrainz', normalizedQuery);
    const { data: result, cached } = await cacheGetOrFetch<MusicBrainzSearchResponse | null>(
      cacheKey,
      () => searchMusicBrainz(normalizedQuery),
      MUSICBRAINZ_CACHE_TTL,
      // null means MusicBrainz did not answer. Never cache that — otherwise one
      // hiccup makes an artist look link-less for the full 30 minute TTL.
      data => data !== null,
    );

    if (cached) {
      console.log('[MusicBrainz] Cache hit');
    }

    if (result === null) {
      const shouldCapture = await checkSentryDedup('uns152:musicbrainz-unavailable', 30 * 60);
      if (shouldCapture) {
        Sentry.captureMessage('MusicBrainz did not answer; enrichment skipped', {
          level: 'warning',
          extra: { query: normalizedQuery, note: 'Result deliberately not cached.' },
        });
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          // Do not let the CDN cache an unavailable upstream either.
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(unavailableResult(query)),
      };
    }

    // Suppressed links are stripped before anything else sees them, so they are
    // neither returned to the client nor persisted into the artist database.
    const filtered = stripSuppressedLinks(result, await suppressionsPromise);

    // Persist enrichment to the artist database.
    // Also persist on MB-miss if we at least captured location (from the
    // Bandcamp/Mirlo fallback), keyed on the normalized query's slug.
    const persistName = filtered.artistName || (filtered.location ? normalizedQuery : null);
    if (persistName) {
      try {
        await persistEnrichment(persistName, filtered);
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
      body: JSON.stringify(filtered),
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
