import { parse } from 'node-html-parser';
import { Sentry } from '../lib/sentry';
import { findBandcampArtist } from '../search/bandcamp-probe';
import { cacheGetOrFetch, artistCacheKey } from './cache';
import { persistSearchResults, getArtistBySlug, artistSlug, getMergeOverrides, getLinkSuppressions, findKnownArtistSlugsByName } from './db';
import { checkRateLimit, checkSentryDedup, getClientIp } from './ratelimit';
import { validateQuery } from './middleware';
import { parseMirloArtistSearch } from './search-parsers';
import {
  type SourceId,
  type LatestRelease,
  type PlatformResult,
  type AggregatedResult,
  type SearchResponse,
  type NameOnlyEntry,
  type SearchMode,
  normalizeSearchQuery,
  normalizeForComparison,
  namesEqualIgnoringArticles,
  isExactNameMatch,
  filterNameOnlyMapToExact,
  looksLikeOpaqueId,
  collectMbSuggestions,
  isCacheableMbResult,
  CURATED_PLATFORMS,
  collectReleaseTitles,
  aggregateResults,
  attachAmpwallAndSearchLinks,
  pickQobuzUrl,
  splitSuspiciousPlatforms,
  mergeByReleaseOverlap,
  filterAndSort,
  applyMergeOverrides,
  applyLinkSuppressions,
  mergeStoredArtistsIntoResults,
  displayNameFromSlug,
  isBandcampSearchLink,
  bandcampSubdomainOf,
  bandcampSubdomainConflicts,
  musicBrainzArtistQuery,
} from './search-utils';

// Import shared enrichment functions
import {
  type SocialLink,
  type DiscoveredPlatformLink,
  type ArtistLocation,
  type SocialPlatform,
  parseSocialUrl,
  fetchDiscogsSocialLinks,
  fetchOfficialSiteSocialLinks,
  mergeSocialLinks,
  searchPeerTubeChannels,
  fetchLinktreeLinks,
  mergeLocations,
  fetchBandcampLocation,
  checkBandcampSubdomain,
  fetchMirloLocation,
  enrichLocationFallback,
  fetchWikipediaSummary,
} from '../search/enrichment';

// Helper to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 3000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Cache TTL for platform searches (30 minutes)
const PLATFORM_CACHE_TTL = 30 * 60;

// How long a FAILED platform search is remembered. Deliberately far shorter than
// PLATFORM_CACHE_TTL: long enough that an outage doesn't make every search wait out
// the upstream timeout, short enough that a transient blip clears in a minute.
const PLATFORM_FAILURE_CACHE_TTL = 60;

// Find the artist on Bandcamp by probing candidate subdomains.
//
// bandcamp.com/search is behind a bot challenge and is Disallow'ed in Bandcamp's
// robots.txt, so this used to return [] and Phase 1 surfaced no Bandcamp results at
// all — the only Bandcamp link came from a MusicBrainz relation, or a generic
// "go search Bandcamp yourself" fallback added in attachAmpwallAndSearchLinks.
//
// The probe covers roughly twice as many artists as MusicBrainz relations alone, and
// its result is cached (negatives included), so a repeat query costs one DB read.
// See docs/specs/bandcamp-coverage-research.md.
async function searchBandcamp(query: string): Promise<PlatformResult[]> {
  const match = await findBandcampArtist(query, 3000);
  if (!match) return [];
  return [{
    sourceId: 'bandcamp',
    name: match.bandName ?? query,
    type: 'artist',
    url: match.url,
    // Carried from the /music page the probe already read, sparing
    // fetchReleasesForDisambiguation two more requests against its shared 4s budget.
    allReleaseTitles: match.releaseTitles.length > 0 ? match.releaseTitles : undefined,
    // Artist photo. aggregateResults carries imageUrl from a PlatformResult, so this is
    // what gives results a picture (Bandcamp replaced Qobuz as the image source in #325).
    imageUrl: match.imageUrl ?? undefined,
  }];
}

// How many discovered artist names get a Bandcamp probe per search. Each probe is
// up to three requests once, then cached in Supabase, so this bounds the cold case.
const MAX_CANDIDATE_PROBES = 3;

// Probe Bandcamp for artist names *other platforms* discovered.
//
// searchBandcamp derives its slugs from the query spelling, so it structurally
// cannot find an artist whose name merely contains the query: "argent" never
// probes theargentgrub.bandcamp.com. But when Mirlo, Bandwagon, or MusicBrainz
// report an artist named "The Argent Grub", probing *that name* finds the account.
// The probe's own identity + release checks still apply, so a candidate name can
// only ever attach a Bandcamp page that verifiably belongs to it.
async function probeBandcampForCandidates(
  query: string,
  candidateNames: string[],
  existingBandcampUrls: Set<string>,
): Promise<PlatformResult[]> {
  const queryNorm = normalizeForComparison(query);
  const toProbe: string[] = [];
  const seen = new Set<string>();
  for (const name of candidateNames) {
    const norm = normalizeForComparison(name);
    // The query itself was already probed by searchBandcamp.
    if (!norm || norm === queryNorm || seen.has(norm)) continue;
    seen.add(norm);
    toProbe.push(name);
    if (toProbe.length >= MAX_CANDIDATE_PROBES) break;
  }
  if (toProbe.length === 0) return [];

  const probes = await Promise.allSettled(toProbe.map(name => findBandcampArtist(name, 2500)));

  const results: PlatformResult[] = [];
  const seenUrls = new Set(existingBandcampUrls);
  for (const probe of probes) {
    if (probe.status !== 'fulfilled' || !probe.value) continue;
    const match = probe.value;
    if (!match.bandName || seenUrls.has(match.url)) continue;
    seenUrls.add(match.url);
    results.push({
      sourceId: 'bandcamp',
      name: match.bandName,
      type: 'artist',
      url: match.url,
      allReleaseTitles: match.releaseTitles.length > 0 ? match.releaseTitles : undefined,
      imageUrl: match.imageUrl ?? undefined,
    });
  }
  return results;
}

// Fetch latest release from a Bandcamp artist page, then get release date from album page
// Uses /music endpoint to get full discography (base URL may redirect to a single release)
async function getBandcampLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    // Extract base artist URL and append /music for full discography
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();
    const root = parse(html);

    // Find the first music grid item (most recent release)
    const musicGridItem = root.querySelector('.music-grid-item');
    if (!musicGridItem) return undefined;

    const link = musicGridItem.querySelector('a');
    const titleEl = musicGridItem.querySelector('.title');
    const artImg = musicGridItem.querySelector('img');

    if (!link || !titleEl) return undefined;

    const href = link.getAttribute('href');
    const title = titleEl.textContent?.trim();
    const imageUrl = artImg?.getAttribute('src') || artImg?.getAttribute('data-original');

    if (!href || !title) return undefined;

    // Determine if it's an album or track based on URL
    const type: 'album' | 'track' = href.includes('/track/') ? 'track' : 'album';

    // Build full URL if relative
    const fullUrl = href.startsWith('http') ? href : new URL(href, artistUrl).toString();

    // Fetch the album/track page to get release date
    let releaseDate: string | undefined;
    try {
      const albumResponse = await fetchWithTimeout(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 3000);

      if (albumResponse.ok) {
        const albumHtml = await albumResponse.text();
        // Look for release date in album-info or meta tags
        // Bandcamp format: "released December 6, 2024" or in JSON-LD
        const dateMatch = albumHtml.match(/released\s+(\w+\s+\d+,\s+\d{4})/i) ||
                          albumHtml.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})"/);
        if (dateMatch) {
          releaseDate = dateMatch[1];
        }
      }
    } catch {
      // Ignore errors fetching album page - we still have the release info
    }

    return {
      title,
      type,
      url: fullUrl,
      imageUrl: imageUrl || undefined,
      releaseDate,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Bandcamp latest release fetch error:', err.message);
    }
    return undefined;
  }
}

// Fetch all release titles from a Bandcamp artist page for disambiguation
async function getBandcampReleaseTitles(artistUrl: string): Promise<string[]> {
  try {
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return [];

    const html = await response.text();
    const root = parse(html);

    const titles: string[] = [];
    const musicGridItems = root.querySelectorAll('.music-grid-item');

    for (const item of musicGridItems) {
      const titleEl = item.querySelector('.title');
      const title = titleEl?.textContent?.trim();
      if (title) {
        titles.push(normalizeForComparison(title));
      }
      // Limit to first 20 releases for performance
      if (titles.length >= 20) break;
    }

    return titles;
  } catch {
    return [];
  }
}

// Search Bandwagon for artists by scraping search results
async function searchBandwagon(query: string): Promise<Map<string, NameOnlyEntry>> {
  const results = new Map<string, NameOnlyEntry>();
  const searchUrl = `https://bandwagon.fm/artists?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return results;

    const html = await response.text();
    const root = parse(html);
    const queryNormalized = normalizeForComparison(query);

    const artistLinks = root.querySelectorAll('a[href*="bandwagon.fm/@"]');
    const seen = new Set<string>();

    for (const link of artistLinks) {
      const href = link.getAttribute('href');
      const nameEl = link.querySelector('.bold');
      const name = nameEl?.textContent?.trim();

      if (href && name && !seen.has(href) && name.length > 0 && name.length < 100) {
        seen.add(href);
        const normalizedName = normalizeForComparison(name);

        if (normalizedName === queryNormalized ||
            normalizedName.includes(queryNormalized) ||
            queryNormalized.includes(normalizedName)) {
          if (!results.has(normalizedName)) {
            // Keep the artist's real name: Bandwagon URLs can be opaque account
            // ids (bandwagon.fm/@695d15c1...), so the slug is not a display name.
            results.set(normalizedName, { url: href, displayName: name });
          }
          if (results.size >= 10) break;
        }
      }
    }
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error('Bandwagon search error:', err.message);
    }
  }

  return results;
}

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// MusicBrainz enriched result interface with full enrichment data
interface EnrichedMusicBrainzResult {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  bandcampUrl: string | null;
  /**
   * The Bandcamp subdomain MusicBrainz says belongs to this artist, recorded even when
   * the account behind it has been retired and `bandcampUrl` was therefore dropped.
   *
   * MB is authoritative about *which* account is the artist's, independent of whether
   * that account still exists — so a probe hit on a different subdomain is evidence of
   * a different artist, not a better link. See `bandcampSubdomainConflicts`.
   */
  bandcampSubdomain: string | null;
  qobuzUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
  discoveredPlatforms: DiscoveredPlatformLink[];
  platformUrls: string[];
  wikipediaSummary: string | null;
  wikipediaUrl: string | null;
  location: ArtistLocation | undefined;
  /**
   * Partial-match artist names from MB's ranked search results (beyond the top
   * hit), e.g. "Goodnight Argent" for the query "argent". Discovery candidates
   * only — they are verified against Bandcamp before becoming results.
   */
  suggestedNames: string[];
  /** The MB search itself failed (network / non-2xx). We know nothing. */
  searchFailed: boolean;
  /**
   * The url-rels lookup for the matched artist succeeded. When false with a
   * non-null artistName, the identity is known but officialUrl/socialLinks may
   * be missing purely because a fetch failed — the response must say
   * enrichment is still pending, or the client never retries and the artist
   * renders bare (this is how Radiohead shipped without its official site).
   */
  enrichmentComplete: boolean;
}

// Cached wrapper around the MusicBrainz enrichment fetch. MB data for an
// artist changes rarely, and the uncached path costs 2+ rate-limit delays plus
// several fetches — the single slowest leg of the fan-out. Failures and
// partial enrichments are never cached (see isCacheableMbResult).
async function searchMusicBrainz(query: string): Promise<EnrichedMusicBrainzResult> {
  const cacheKey = artistCacheKey('mb-enriched', query);
  const { data } = await cacheGetOrFetch<EnrichedMusicBrainzResult>(
    cacheKey,
    () => fetchMusicBrainzEnrichment(query),
    PLATFORM_CACHE_TTL,
    isCacheableMbResult,
    PLATFORM_FAILURE_CACHE_TTL,
  );
  return data;
}

// Search MusicBrainz with full enrichment - fetches social links, location, Wikipedia, etc.
async function fetchMusicBrainzEnrichment(query: string): Promise<EnrichedMusicBrainzResult> {
  const emptyResult: EnrichedMusicBrainzResult = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    bandcampUrl: null,
    bandcampSubdomain: null,
    qobuzUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
    discoveredPlatforms: [],
    platformUrls: [],
    wikipediaSummary: null,
    wikipediaUrl: null,
    location: undefined,
    suggestedNames: [],
    searchFailed: false,
    enrichmentComplete: true,
  };

  try {
    // Search for artist. MB is Lucene-backed and its ranked list is the one real
    // search engine in the fan-out: the top hit drives enrichment (strict gates
    // below), the rest become discovery candidates via collectMbSuggestions.
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(musicBrainzArtistQuery(query))}&fmt=json&limit=5`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return { ...emptyResult, searchFailed: true };
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) {
      console.log(`[MusicBrainz] No results for "${query}", falling back to Bandcamp/Mirlo location`);
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    const artist = artists[0];
    // Only consider exact/near-exact matches for enrichment. Lower-scored hits are
    // still worth reporting as discovery candidates — they just don't get to claim
    // the MB identity (official site, socials, location) for themselves.
    if (artist.score < 95) {
      console.log(`[MusicBrainz] Low confidence match for "${query}" (score ${artist.score}), falling back to Bandcamp/Mirlo location`);
      return {
        ...emptyResult,
        suggestedNames: collectMbSuggestions(artists, query),
        location: await enrichLocationFallback(query),
      };
    }

    // Verify the returned artist name actually matches the query.
    //
    // Must use normalizeForComparison, which strips accents. A bare
    // .replace(/[^a-z0-9]/g, '') *deletes* accented letters instead: MusicBrainz returns
    // "Tanerélle" -> "tanerlle" while the query arrives already accent-normalized as
    // "Tanerelle" -> "tanerelle", so every accented artist name failed this check and
    // lost all MB enrichment — including their Qobuz link, which MB is now the only
    // source of.
    const queryNormalized = normalizeForComparison(query);
    const artistNormalized = normalizeForComparison(artist.name);
    const isNameMatch = queryNormalized === artistNormalized ||
      queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7 ||
      artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7;

    if (!isNameMatch) {
      console.log(`[MusicBrainz] Skipping "${artist.name}" - doesn't match query "${query}", falling back to Bandcamp/Mirlo location`);
      return {
        ...emptyResult,
        suggestedNames: collectMbSuggestions(artists, query),
        location: await enrichLocationFallback(query),
      };
    }

    // Wait 1.1 seconds to respect MusicBrainz rate limit
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
    let bandcampUrl: string | null = null;
    let qobuzUrl: string | null = null;
    let linktreeUrl: string | null = null;
    let wikipediaUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();
    let platformUrls: string[] = [];

    let mbLocation: ArtistLocation | undefined;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: { type: string; url?: { resource: string } }[];
        country?: string;
        area?: { name: string; type?: string | null; 'iso-3166-1-codes'?: string[] };
        'begin-area'?: { name: string; type?: string | null };
      };

      // Parse location from area / begin-area fields
      const topLevelCountryCode = artistData.country;
      if (artistData.area) {
        if (artistData.area.type === 'Country') {
          mbLocation = {
            country: artistData.area.name,
            countryCode: artistData.area['iso-3166-1-codes']?.[0] ?? topLevelCountryCode,
          };
        } else {
          mbLocation = {
            city: artistData.area.name,
            countryCode: topLevelCountryCode,
          };
        }
      } else if (topLevelCountryCode) {
        mbLocation = { countryCode: topLevelCountryCode };
      }
      if (artistData['begin-area'] && artistData['begin-area'].name !== artistData.area?.name) {
        const beginType = artistData['begin-area'].type;
        if (beginType === 'Country' && !mbLocation?.country) {
          mbLocation = { ...mbLocation, country: artistData['begin-area'].name };
        } else if (beginType !== 'Country') {
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

      // Look for Bandcamp link
      for (const rel of relations) {
        if (rel.type === 'bandcamp' && rel.url?.resource) {
          bandcampUrl = rel.url.resource;
          break;
        }
        if (!bandcampUrl && rel.url?.resource) {
          try {
            const hostname = new URL(rel.url.resource).hostname;
            if (hostname.endsWith('.bandcamp.com')) {
              bandcampUrl = rel.url.resource;
              break;
            }
          } catch {}
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
      for (const rel of relations) {
        if ((rel.type === 'social network' || rel.type === 'youtube') && rel.url?.resource) {
          const url = rel.url.resource;
          if (url.includes('linktr.ee') && !linktreeUrl) {
            linktreeUrl = url;
            console.log(`[MusicBrainz] Found Linktree: ${linktreeUrl}`);
            continue;
          }
          const socialLink = parseSocialUrl(url);
          if (socialLink && !seenPlatforms.has(socialLink.platform)) {
            seenPlatforms.add(socialLink.platform);
            socialLinks.push(socialLink);
          }
        }
      }

      // Extract platform URLs for disambiguation
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
        console.log(`[MusicBrainz] Found ${platformUrls.length} platform URLs`);
      }
      qobuzUrl = pickQobuzUrl(platformUrls);
      if (qobuzUrl) {
        console.log(`[MusicBrainz] Found Qobuz link: ${qobuzUrl}`);
      }
    }

    await delay(1100);

    // Check if artist has pre-2005 releases
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

    // Fetch enrichment data in parallel
    const mirloSlug = artist.name.toLowerCase().replace(/\s+/g, '');
    const [discogsSocialLinks, officialSiteResult, peertubeLink, wikipediaResult, bandcampLocation, mirloLocation, bandcampStatus] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null, discoveredPlatforms: [] }),
      searchPeerTubeChannels(artist.name),
      wikipediaUrl ? fetchWikipediaSummary(wikipediaUrl) : Promise.resolve(null),
      bandcampUrl ? fetchBandcampLocation(bandcampUrl) : Promise.resolve(null),
      fetchMirloLocation(mirloSlug),
      // Rides in this existing parallel block, so a confirmed-dead link costs no
      // extra wall-clock — and only runs at all when MB actually has a Bandcamp rel.
      bandcampUrl ? checkBandcampSubdomain(bandcampUrl) : Promise.resolve('unknown' as const),
    ]);

    // Drop a retired subdomain here, at the single point where MB's Bandcamp link enters
    // the pipeline, rather than at each of the four places that later read it. Only a
    // confirmed 'dead' is dropped; 'unknown' keeps the old behaviour of trusting MB.
    // Captured before the dead-link drop below: the identity claim outlives the account.
    const mbClaimedBandcampUrl = bandcampUrl;

    if (bandcampUrl && bandcampStatus === 'dead') {
      console.log(`[MusicBrainz] Dropping retired Bandcamp subdomain for "${artist.name}": ${bandcampUrl}`);
      platformUrls = platformUrls.filter(u => u !== bandcampUrl);
      // MB is the only place this artist's Bandcamp account is recorded, and the record
      // is stale. Worth knowing about: the fix is an edit upstream, not in our code.
      const shouldCapture = await checkSentryDedup(`dead-bandcamp:${bandcampUrl}`, 7 * 24 * 60 * 60);
      if (shouldCapture) {
        Sentry.captureMessage('MusicBrainz Bandcamp relation points at a retired subdomain', {
          level: 'info',
          extra: { artist: artist.name, bandcampUrl, query },
          tags: { platform: 'bandcamp' },
        });
      }
      bandcampUrl = null;
    }

    // Merge locations
    const location = mergeLocations(mbLocation, bandcampLocation, mirloLocation);

    // Scrape Linktree if found
    let linktreeSocialLinks: SocialLink[] = [];
    const finalLinktreeUrl = linktreeUrl || officialSiteResult.linktreeUrl;
    if (finalLinktreeUrl) {
      linktreeSocialLinks = await fetchLinktreeLinks(finalLinktreeUrl);
    }

    // Collect PeerTube link
    const peertubeLinks: SocialLink[] = peertubeLink ? [peertubeLink] : [];

    // Merge all social links
    const allSocialLinks = mergeSocialLinks(
      socialLinks,
      discogsSocialLinks,
      officialSiteResult.socialLinks,
      linktreeSocialLinks,
      peertubeLinks
    );

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      bandcampUrl,
      bandcampSubdomain: bandcampSubdomainOf(mbClaimedBandcampUrl),
      qobuzUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
      discoveredPlatforms: officialSiteResult.discoveredPlatforms,
      platformUrls,
      wikipediaSummary: wikipediaResult?.extract || null,
      wikipediaUrl: wikipediaResult?.pageUrl || wikipediaUrl,
      location,
      suggestedNames: collectMbSuggestions(artists, query, artist.name),
      searchFailed: false,
      enrichmentComplete: artistResponse.ok,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return { ...emptyResult, searchFailed: true };
  }
}

// Search Mirlo through its public artist search API.
//
// This used to be a bare probe of mirlo.space/<query-with-spaces-removed>, which
// could only find an artist whose URL slug happened to equal the query spelling —
// partial queries and differently-slugged artists were invisible. The API matches
// server-side (loosely; parseMirloArtistSearch re-filters), so "argent" now finds
// "The Argent Grub" at mirlo.space/the-argent-grub.
async function searchMirlo(query: string): Promise<PlatformResult[]> {
  const cacheKey = artistCacheKey('mirlo', query);
  // Set when the upstream did not answer. A failure must not be cached as
  // "this artist isn't on mirlo" -- see the shouldCache predicate below.
  let fetchFailed = false;

  const { data } = await cacheGetOrFetch<PlatformResult[]>(
    cacheKey,
    async () => {
      try {
        const response = await fetchWithTimeout(
          `https://api.mirlo.space/v1/artists?name=${encodeURIComponent(query)}`,
          {
            headers: {
              'User-Agent': 'Unstream/1.0 (+https://unstream.stream)',
              'Accept': 'application/json',
            },
          },
          3000,
        );

        if (!response.ok) { fetchFailed = true; return []; }

        const json = await response.json();
        return parseMirloArtistSearch(json, query);
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        fetchFailed = true;
        if (err.name !== 'AbortError') {
          console.error('Mirlo search error:', err.message);
        }
        return [];
      }
    },
    PLATFORM_CACHE_TTL,
    // A failed fetch must not be cached as "artist not on this platform"...
    () => !fetchFailed,
    // ...but remember it briefly so an outage doesn't cost every search the timeout.
    PLATFORM_FAILURE_CACHE_TTL,
  );

  return data;
}

// Faircamp webring directory cache
let faircampDirectoryCache: Record<string, { title: string; artists: string[]; description: string }> | null = null;
let faircampCacheTime = 0;
const FAIRCAMP_CACHE_TTL = 10 * 60 * 1000;

async function getFaircampDirectory(): Promise<Record<string, { title: string; artists: string[]; description: string }>> {
  const now = Date.now();
  if (faircampDirectoryCache && (now - faircampCacheTime) < FAIRCAMP_CACHE_TTL) {
    return faircampDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://faircamp.webr.ing/directory.json', {}, 5000);
    if (!response.ok) {
      return faircampDirectoryCache || {};
    }
    faircampDirectoryCache = await response.json() as Record<string, { title: string; artists: string[]; description: string }>;
    faircampCacheTime = now;
    return faircampDirectoryCache;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Faircamp directory fetch error:', err.message);
    return faircampDirectoryCache || {};
  }
}

async function searchFaircamp(query: string): Promise<Map<string, NameOnlyEntry>> {
  const results = new Map<string, NameOnlyEntry>();
  const queryLower = query.toLowerCase();

  try {
    const directory = await getFaircampDirectory();

    for (const [domain, info] of Object.entries(directory)) {
      for (const artist of info.artists || []) {
        if (artist.toLowerCase().includes(queryLower) || queryLower.includes(artist.toLowerCase())) {
          const normalizedArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          results.set(normalizedArtist, { url: `https://${domain}`, displayName: artist });
        }
      }
      if (results.size >= 10) break;
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Faircamp search error:', err.message);
  }

  return results;
}

// Scrape release titles from a Faircamp artist page
// Faircamp sites use a consistent static HTML structure: div.release > a (second <a> is the title)
async function getFaircampReleaseTitles(url: string): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 4000);

    if (!response.ok) return [];

    const html = await response.text();
    const root = parse(html);
    const titles: string[] = [];

    // Faircamp uses div.release for each release, with the second <a> containing the title text
    const releases = root.querySelectorAll('.release');
    for (const release of releases) {
      const links = release.querySelectorAll('a');
      // The second <a> in a .release div is the title link (first is the cover image link)
      if (links.length >= 2) {
        const title = links[1].textContent?.trim();
        if (title) titles.push(normalizeForComparison(title));
      }
    }

    if (titles.length > 0) {
      console.log(`[Faircamp] Found ${titles.length} releases at ${url}`);
    }
    return titles;
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name !== 'AbortError') {
      console.error(`[Faircamp] Error fetching releases from ${url}:`, err.message);
    }
    return [];
  }
}

// Jam.coop artist directory cache
let jamcoopDirectoryCache: Map<string, { name: string; url: string }> | null = null;
let jamcoopCacheTime = 0;
const JAMCOOP_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getJamcoopDirectory(): Promise<Map<string, { name: string; url: string }>> {
  const now = Date.now();
  if (jamcoopDirectoryCache && (now - jamcoopCacheTime) < JAMCOOP_CACHE_TTL) {
    return jamcoopDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://jam.coop/artists', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) {
      return jamcoopDirectoryCache || new Map();
    }

    const html = await response.text();
    const root = parse(html);
    const directory = new Map<string, { name: string; url: string }>();

    // Find all artist links - they follow pattern /artists/[slug]
    const artistLinks = root.querySelectorAll('a[href^="/artists/"]');

    for (const link of artistLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/artists') continue;

      // Get artist name from link text (may need to clean up whitespace)
      const name = link.textContent?.trim();
      if (!name) continue;

      const normalizedName = normalizeForComparison(name);
      if (normalizedName && !directory.has(normalizedName)) {
        directory.set(normalizedName, {
          name,
          url: `https://jam.coop${href}`,
        });
      }
    }

    jamcoopDirectoryCache = directory;
    jamcoopCacheTime = now;
    console.log(`[Jam.coop] Cached ${directory.size} artists`);
    return directory;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Jam.coop directory fetch error:', err.message);
    return jamcoopDirectoryCache || new Map();
  }
}

async function searchJamcoop(query: string): Promise<Map<string, NameOnlyEntry>> {
  const results = new Map<string, NameOnlyEntry>();
  const queryNormalized = normalizeForComparison(query);

  try {
    const directory = await getJamcoopDirectory();

    for (const [normalizedName, artist] of directory) {
      // Exact match or close match (query contains name or name contains query)
      if (normalizedName === queryNormalized ||
          normalizedName.includes(queryNormalized) ||
          queryNormalized.includes(normalizedName)) {
        results.set(normalizedName, { url: artist.url, displayName: artist.name });
      }
      if (results.size >= 10) break;
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Jam.coop search error:', err.message);
  }

  return results;
}

async function searchPatreon(query: string): Promise<Map<string, NameOnlyEntry>> {
  const cacheKey = artistCacheKey('patreon', query);
  // Set when the upstream did not answer. A failure must not be cached as
  // "this artist isn't on patreon" -- see the shouldCache predicate below.
  let fetchFailed = false;

  const { data } = await cacheGetOrFetch<[string, NameOnlyEntry | string][]>(
    cacheKey,
    async () => {
      const results: [string, NameOnlyEntry][] = [];
      const seen = new Set<string>();

      try {
        const searchUrl = `https://www.patreon.com/api/search?q=${encodeURIComponent(query)}`;
        const response = await fetchWithTimeout(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
        }, 5000);

        if (!response.ok) { fetchFailed = true; return results; }

        const data = await response.json() as {
          data?: {
            type: string;
            attributes?: {
              creator_name?: string;
              url?: string;
            };
          }[];
        };

        const campaigns = data.data || [];

        for (const campaign of campaigns) {
          if (campaign.type === 'campaign-document' && campaign.attributes) {
            const creatorName = campaign.attributes.creator_name;
            const url = campaign.attributes.url;

            if (creatorName && url) {
              const normalizedName = normalizeForComparison(creatorName);
              if (!seen.has(normalizedName)) {
                seen.add(normalizedName);
                results.push([normalizedName, { url, displayName: creatorName }]);
              }
              const urlSlug = url.split('/').pop();
              if (urlSlug) {
                const normalizedSlug = normalizeForComparison(urlSlug);
                if (!seen.has(normalizedSlug)) {
                  seen.add(normalizedSlug);
                  results.push([normalizedSlug, { url, displayName: creatorName }]);
                }
              }
            }
          }
          if (results.length >= 20) break;
        }
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        fetchFailed = true;
        if (err.name !== 'AbortError') {
          console.error('Patreon search error:', err.message);
        }
      }

      return results;
    },
    PLATFORM_CACHE_TTL,
    // A failed fetch must not be cached as "artist not on this platform"...
    () => !fetchFailed,
    // ...but remember it briefly so an outage doesn't cost every search the timeout.
    PLATFORM_FAILURE_CACHE_TTL,
  );

  return coerceNameOnlyCache(data);
}

// Cache entries written before display names were carried hold a bare URL string.
// Coerce them so a deploy doesn't invalidate every warm entry; the string form
// ages out with the 30-minute platform TTL.
function coerceNameOnlyCache(data: [string, NameOnlyEntry | string][]): Map<string, NameOnlyEntry> {
  return new Map(data.map(([name, entry]) =>
    [name, typeof entry === 'string' ? { url: entry } : entry] as [string, NameOnlyEntry]
  ));
}

// Search Ampwall with Redis caching to minimize API load
// Cache TTL: 30 minutes (1800 seconds)
const AMPWALL_CACHE_TTL = 30 * 60;

async function searchAmpwall(query: string): Promise<Map<string, string>> {
  const cacheKey = artistCacheKey('ampwall', query);
  // No shouldCache guard here: this is still a stub with no outbound request, so it
  // cannot fail and its empty result is a genuine answer rather than a hidden error.
  const { data, cached } = await cacheGetOrFetch<[string, string][]>(
    cacheKey,
    async () => {
      const results: [string, string][] = [];

      // TODO: Replace this with actual Ampwall API call when available
      // Expected API format TBD - placeholder implementation
      //
      // Example expected implementation:
      // const apiUrl = `https://api.ampwall.com/search?q=${encodeURIComponent(query)}`;
      // const response = await fetchWithTimeout(apiUrl, {
      //   headers: {
      //     'Authorization': `Bearer ${process.env.AMPWALL_API_KEY}`,
      //     'Accept': 'application/json',
      //   },
      // }, 5000);
      //
      // if (response.ok) {
      //   const data = await response.json();
      //   for (const artist of data.artists || []) {
      //     const normalizedName = normalizeForComparison(artist.name);
      //     results.push([normalizedName, artist.url]);
      //   }
      // }

      return results;
    },
    AMPWALL_CACHE_TTL
  );

  if (cached) {
    console.log(`[Ampwall] Cache hit for "${query}"`);
  }

  // Convert array back to Map (Redis doesn't serialize Maps well)
  return new Map(data);
}

// Search Beatport via __NEXT_DATA__ JSON embedded in search page
async function searchBeatport(query: string): Promise<Map<string, NameOnlyEntry>> {
  const cacheKey = artistCacheKey('beatport', query);
  // Set when the upstream did not answer. A failure must not be cached as
  // "this artist isn't on beatport" -- see the shouldCache predicate below.
  let fetchFailed = false;

  const { data } = await cacheGetOrFetch<[string, NameOnlyEntry | string][]>(
    cacheKey,
    async () => {
      const results: [string, NameOnlyEntry][] = [];

      try {
        const searchUrl = `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
        const response = await fetchWithTimeout(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        }, 5000);

        if (!response.ok) { fetchFailed = true; return results; }

        const html = await response.text();
        const root = parse(html);
        const scriptEl = root.querySelector('script#__NEXT_DATA__');
        if (!scriptEl) return results;

        const json = JSON.parse(scriptEl.textContent);
        const queries = json?.props?.pageProps?.dehydratedState?.queries;
        // Find the query result that contains artist data
        let artists: { artist_id: number; artist_name: string; slug?: string }[] | undefined;
        for (const q of queries || []) {
          const data = q?.state?.data?.artists?.data;
          if (Array.isArray(data)) {
            artists = data;
            break;
          }
        }
        if (!artists) return results;

        const queryNormalized = normalizeForComparison(query);
        const seen = new Set<string>();

        for (const artist of artists.slice(0, 10)) {
          const { artist_name, artist_id } = artist;
          if (!artist_name || !artist_id) continue;

          const normalizedName = normalizeForComparison(artist_name);

          // Strict matching: exact, query prefix, or numeric suffix variation
          const isMatch = normalizedName === queryNormalized ||
            queryNormalized.startsWith(normalizedName) ||
            (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

          if (isMatch && !seen.has(normalizedName)) {
            seen.add(normalizedName);
            const slug = artist_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            results.push([normalizedName, {
              url: `https://www.beatport.com/artist/${slug}/${artist_id}`,
              displayName: artist_name,
            }]);
          }
        }
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        fetchFailed = true;
        if (err.name !== 'AbortError') {
          console.error('Beatport search error:', err.message);
        }
      }

      return results;
    },
    PLATFORM_CACHE_TTL,
    // A failed fetch must not be cached as "artist not on this platform"...
    () => !fetchFailed,
    // ...but remember it briefly so an outage doesn't cost every search the timeout.
    PLATFORM_FAILURE_CACHE_TTL,
  );

  return coerceNameOnlyCache(data);
}

// Search EVEN via Algolia API (direct-to-fan marketplace)
async function searchEven(query: string): Promise<Map<string, NameOnlyEntry>> {
  const cacheKey = artistCacheKey('even', query);
  // Set when the upstream did not answer. A failure must not be cached as
  // "this artist isn't on even" -- see the shouldCache predicate below.
  let fetchFailed = false;

  const { data } = await cacheGetOrFetch<[string, NameOnlyEntry | string][]>(
    cacheKey,
    async () => {
      const results: [string, NameOnlyEntry][] = [];

      try {
        const algoliaAppId = process.env.ALGOLIA_APP_ID || 'S64VD9CU46';
        const algoliaApiKey = process.env.ALGOLIA_API_KEY;
        if (!algoliaApiKey) {
          console.warn('[EVEN] Missing ALGOLIA_API_KEY env var, skipping Even search');
          return results;
        }

        const response = await fetchWithTimeout('https://S64VD9CU46-dsn.algolia.net/1/indexes/Artist/query', {
          method: 'POST',
          headers: {
            'X-Algolia-Application-Id': algoliaAppId,
            'X-Algolia-API-Key': algoliaApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, hitsPerPage: 10 }),
        }, 5000);

        if (!response.ok) { fetchFailed = true; return results; }

        const json = await response.json() as { hits?: { name?: string; slug?: string; username?: string }[] };
        const queryNormalized = normalizeForComparison(query);
        const seen = new Set<string>();

        for (const hit of json.hits || []) {
          const name = hit.name;
          const slug = hit.slug || hit.username;
          if (!name || !slug) continue;

          const normalizedName = normalizeForComparison(name);

          // Strict matching: exact, query prefix, or numeric suffix variation
          const isMatch = normalizedName === queryNormalized ||
            queryNormalized.startsWith(normalizedName) ||
            (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

          if (isMatch && !seen.has(normalizedName)) {
            seen.add(normalizedName);
            results.push([normalizedName, { url: `https://even.biz/artists/${slug}`, displayName: name }]);
          }
        }
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        fetchFailed = true;
        if (err.name !== 'AbortError') {
          console.error('EVEN search error:', err.message);
        }
      }

      return results;
    },
    PLATFORM_CACHE_TTL,
    // A failed fetch must not be cached as "artist not on this platform"...
    () => !fetchFailed,
    // ...but remember it briefly so an outage doesn't cost every search the timeout.
    PLATFORM_FAILURE_CACHE_TTL,
  );

  return coerceNameOnlyCache(data);
}

// ---------------------------------------------------------------------------
// Phase 3: Fetch releases & disambiguate
// ---------------------------------------------------------------------------

/**
 * Fetch Bandcamp release data used for disambiguation, bounded by one shared 4s race.
 */
async function fetchReleasesForDisambiguation(
  aggregated: AggregatedResult[],
): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const result of aggregated) {
    if (result.type !== 'artist') continue;

    const bc = result.platforms.find(p => p.sourceId === 'bandcamp');
    if (bc) {
      promises.push(getBandcampLatestRelease(bc.url).then(r => { if (r) bc.latestRelease = r; }));
      // Skip when the probe already supplied titles — these fetches share one 4s race,
      // so a redundant request costs another artist its release data.
      if (!bc.allReleaseTitles || bc.allReleaseTitles.length === 0) {
        promises.push(getBandcampReleaseTitles(bc.url).then(t => { if (t.length > 0) bc.allReleaseTitles = t; }));
      }
    }
  }

  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
}

// ---------------------------------------------------------------------------
// Phase 4: Attach deferred name-only platforms & final filter/sort
// ---------------------------------------------------------------------------

async function attachNameOnlyPlatforms(
  merged: AggregatedResult[],
  nameOnlyMaps: [string, Map<string, NameOnlyEntry>][],
): Promise<void> {
  // Step 1: Group all name-only platform matches by normalized artist name.
  // This ensures Faircamp + Jamcoop + Bandwagon for the same artist travel together.
  // Also track display names from the original match maps.
  const groupedByName = new Map<string, { sourceId: string; url: string }[]>();
  const displayNames = new Map<string, string>(); // normalizedName -> best display name
  for (const [platformId, matchMap] of nameOnlyMaps) {
    for (const [normalizedName, entry] of matchMap) {
      if (!groupedByName.has(normalizedName)) groupedByName.set(normalizedName, []);
      groupedByName.get(normalizedName)!.push({ sourceId: platformId, url: entry.url });
      // Prefer the name the platform actually displayed; reconstruct from the URL
      // slug only as a fallback, and never from an opaque account id — that's how
      // "@695d15c12f0f56fdced0a5e6" once shipped as a result name.
      if (entry.displayName) {
        displayNames.set(normalizedName, entry.displayName);
      } else if (!displayNames.has(normalizedName)) {
        try {
          const urlObj = new URL(entry.url);
          const slug = urlObj.pathname.split('/').filter(Boolean).pop() || '';
          if (slug && !looksLikeOpaqueId(slug)) {
            displayNames.set(normalizedName, displayNameFromSlug(slug));
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Step 2: For each artist name group, attach or create a new result
  for (const [normalizedName, platforms] of groupedByName) {
    let matching = merged.filter(
      r => r.type === 'artist' && normalizeForComparison(r.name) === normalizedName
    );
    // No exact-name result: platforms disagree about leading articles often enough
    // ("Argent Grub" on Bandwagon, "The Argent Grub" on Bandcamp) that a hit is
    // also accepted when the names differ only by one. Anything looser than that
    // (substring, prefix) would attach one artist's links to another.
    if (matching.length === 0) {
      const displayName = displayNames.get(normalizedName);
      if (displayName) {
        matching = merged.filter(
          r => r.type === 'artist' && namesEqualIgnoringArticles(r.name, displayName)
        );
      }
    }

    // Filter out platforms already present on any matching result
    const toAttach = platforms.filter(
      p => !matching.some(r => r.platforms.some(rp => rp.sourceId === p.sourceId))
    );
    if (toAttach.length === 0) continue;

    // Unambiguous: only one result with this name
    if (matching.length === 1) {
      for (const p of toAttach) {
        matching[0].platforms.push({ sourceId: p.sourceId as SourceId, url: p.url });
      }
      continue;
    }

    if (matching.length === 0) {
      // No existing results — only create a new result if we have at least one curated platform.
      // Patreon returns fuzzy search results that often don't match by name, so Patreon alone
      // should never create a new result.
      const hasCuratedPlatform = toAttach.some(p => CURATED_PLATFORMS.has(p.sourceId));
      if (!hasCuratedPlatform) {
        console.log(`[Deferred Attach] Skipping "${normalizedName}" — no curated platform, no existing result`);
        continue;
      }

      const displayName = displayNames.get(normalizedName) || normalizedName;
      const faircampEntry = toAttach.find(p => p.sourceId === 'faircamp');

      const newResult: AggregatedResult = {
        id: `nameonly-${normalizedName}`,
        name: displayName,
        type: 'artist',
        platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
        matchConfidence: 'unverified',
        unverifiedReason: 'no-release-data',
      };

      // If we have Faircamp, fetch releases to seed the result
      if (faircampEntry) {
        const titles = await getFaircampReleaseTitles(faircampEntry.url);
        if (titles.length > 0) {
          const fcPlatform = newResult.platforms.find(p => p.sourceId === 'faircamp');
          if (fcPlatform) fcPlatform.allReleaseTitles = titles;
          newResult.matchConfidence = 'verified';
          newResult.unverifiedReason = undefined;
        }
      }

      merged.push(newResult);
      console.log(`[Deferred Attach] Created new result for "${displayName}" with ${toAttach.map(p => p.sourceId).join(', ')}`);
      continue;
    }

    // Ambiguous: multiple same-name results exist after disambiguation.
    // Use Faircamp release data to find the right match.
    const faircampPlatform = toAttach.find(p => p.sourceId === 'faircamp');
    let faircampTitles: string[] = [];

    if (faircampPlatform) {
      faircampTitles = await getFaircampReleaseTitles(faircampPlatform.url);
    }

    if (faircampTitles.length > 0) {
      // Compare Faircamp releases against each existing result
      let bestResult: AggregatedResult | null = null;
      let bestOverlap = 0;

      for (const result of matching) {
        const resultTitles = collectReleaseTitles(result);
        if (resultTitles.size === 0) continue;

        const overlap = faircampTitles.filter(t => resultTitles.has(t)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestResult = result;
        }
      }

      if (bestResult && bestOverlap > 0) {
        // Found a match — attach all platforms in this group to that result
        for (const p of toAttach) {
          bestResult.platforms.push({ sourceId: p.sourceId as SourceId, url: p.url });
        }
        // Store Faircamp release titles for future disambiguation
        const fcPlatform = bestResult.platforms.find(p => p.sourceId === 'faircamp');
        if (fcPlatform) fcPlatform.allReleaseTitles = faircampTitles;
        console.log(`[Deferred Attach] Faircamp releases matched "${bestResult.name}" (${bestOverlap} overlapping titles) — attached ${toAttach.map(p => p.sourceId).join(', ')}`);
      } else {
        // No release overlap with any existing result — this is a DIFFERENT artist.
        // Create a new result with all the name-only platforms.
        // Reconstruct a display name from the first matching result (they share the same name)
        const displayName = matching[0].name;
        const newResult: AggregatedResult = {
          id: `nameonly-${normalizedName}-${Date.now()}`,
          name: displayName,
          type: 'artist',
          platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
          matchConfidence: 'verified',
        };
        // Seed Faircamp release titles
        const fcPlatform = newResult.platforms.find(p => p.sourceId === 'faircamp');
        if (fcPlatform) fcPlatform.allReleaseTitles = faircampTitles;

        merged.push(newResult);
        console.log(`[Deferred Attach] No release overlap — created new result for "${displayName}" with ${toAttach.map(p => p.sourceId).join(', ')} (${faircampTitles.length} Faircamp releases)`);
      }
    } else {
      // No Faircamp data available for disambiguation.
      // Only create a separate result if we have curated platforms — otherwise skip.
      const hasCuratedPlatform = toAttach.some(p => CURATED_PLATFORMS.has(p.sourceId));
      if (hasCuratedPlatform) {
        const displayName = matching[0].name;
        const newResult: AggregatedResult = {
          id: `nameonly-${normalizedName}-${Date.now()}`,
          name: displayName,
          type: 'artist',
          platforms: toAttach.map(p => ({ sourceId: p.sourceId as SourceId, url: p.url })),
          matchConfidence: 'unverified',
          unverifiedReason: 'no-release-data',
        };
        merged.push(newResult);
        console.log(`[Deferred Attach] Ambiguous "${displayName}" with no Faircamp data — created separate result with ${toAttach.map(p => p.sourceId).join(', ')}`);
      } else {
        console.log(`[Deferred Attach] Skipping ambiguous "${normalizedName}" — no Faircamp data, no curated platform`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
/**
 * Did MusicBrainz give us a rich answer for this artist — a confirmed name plus at
 * least one real destination?
 *
 * A name-only hit isn't enough: the card it produces is nothing but search links,
 * and calling that verified would overclaim. But once MB hands over an official
 * site, a Discogs page, a Qobuz page or a social profile, it has told us who the
 * artist is and where to find them, which is the question "verified" answers.
 */
function musicBrainzConfirmsIdentity(mbData: EnrichedMusicBrainzResult): boolean {
  if (!mbData.artistName) return false;
  return Boolean(
    mbData.officialUrl ||
    mbData.discogsUrl ||
    mbData.qobuzUrl ||
    (mbData.socialLinks && mbData.socialLinks.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Apply enrichment data to aggregated results (adds officialsite, discogs, social links, etc.)
function applyEnrichmentToResults(
  aggregated: AggregatedResult[],
  mbData: EnrichedMusicBrainzResult
): void {
  if (!mbData.artistName) {
    // MB-miss path: no confirmed identity, but may still have location from Bandcamp/Mirlo fallback
    if (!mbData.location) return;
    const queryNorm = normalizeForComparison(mbData.query);
    const exactIdx = aggregated.findIndex(r => r.type === 'artist' && normalizeForComparison(r.name) === queryNorm);
    const bestIdx = exactIdx !== -1 ? exactIdx : aggregated.findIndex(r => r.type === 'artist');
    if (bestIdx === -1) return;
    aggregated[bestIdx].location = mbData.location;
    return;
  }

  const mbNormalized = normalizeForComparison(mbData.artistName);

  // Find which results match the MusicBrainz artist name
  const matchingIndices: number[] = [];
  for (let i = 0; i < aggregated.length; i++) {
    const result = aggregated[i];
    if (result.type !== 'artist') continue;
    const resultNormalized = normalizeForComparison(result.name);
    const isMatch =
      resultNormalized === mbNormalized ||
      (resultNormalized.includes(mbNormalized) && mbNormalized.length > resultNormalized.length * 0.7) ||
      (mbNormalized.includes(resultNormalized) && resultNormalized.length > mbNormalized.length * 0.7);
    if (!isMatch) continue;

    // Same name, different Bandcamp account — a homonym, not this artist. Enriching it
    // would graft the MB artist's location, socials and Wikipedia entry onto a stranger.
    const bandcampPlatform = result.platforms.find(p => p.sourceId === 'bandcamp');
    if (bandcampSubdomainConflicts(mbData.bandcampSubdomain, bandcampPlatform?.url)) {
      console.log(`[MusicBrainz] "${result.name}" is on a different Bandcamp account than MB lists for "${mbData.artistName}" — not enriching`);
      continue;
    }

    matchingIndices.push(i);
  }

  // Disambiguate using MB platform URLs
  let bestMatchIndex = -1;
  if (matchingIndices.length === 1) {
    bestMatchIndex = matchingIndices[0];
  } else if (matchingIndices.length > 1) {
    const mbPlatformUrls = mbData.platformUrls || [];

    if (mbPlatformUrls.length > 0) {
      const normalizedMbUrls = new Set(mbPlatformUrls.map(u => u.replace(/\/+$/, '').toLowerCase()));

      for (const idx of matchingIndices) {
        const r = aggregated[idx];
        const hasDirectMatch = r.platforms.some(p => {
          const normalized = p.url.replace(/\/+$/, '').toLowerCase();
          return normalizedMbUrls.has(normalized);
        });
        if (hasDirectMatch) {
          bestMatchIndex = idx;
          break;
        }
      }
    }

    if (bestMatchIndex === -1) {
      let bestScore = -1;
      for (const idx of matchingIndices) {
        const r = aggregated[idx];
        const confidenceScore = r.matchConfidence === 'claimed' ? 100 : r.matchConfidence === 'verified' ? 50 : 0;
        const platformScore = r.platforms.filter(p => !['kofi', 'buymeacoffee', 'ampwall'].includes(p.sourceId)).length;
        const score = confidenceScore + platformScore;
        if (score > bestScore) {
          bestScore = score;
          bestMatchIndex = idx;
        }
      }
    }
  }

  if (bestMatchIndex === -1) return;

  const result = aggregated[bestMatchIndex];
  // MB picked this result out of the same-name candidates and is about to attach
  // the artist's real links to it — that is an identity match, not a guess.
  if (musicBrainzConfirmsIdentity(mbData)) {
    result.musicBrainzConfirmed = true;
  }
  const newPlatforms = [...result.platforms];

  // Add official site if available and not already present
  if (mbData.officialUrl && !newPlatforms.some(p => p.sourceId === 'officialsite')) {
    newPlatforms.push({ sourceId: 'officialsite' as SourceId, url: mbData.officialUrl });
  }

  // Add Discogs if available and not already present
  if (mbData.discogsUrl && !newPlatforms.some(p => p.sourceId === 'discogs')) {
    newPlatforms.push({ sourceId: 'discogs' as SourceId, url: mbData.discogsUrl });
  }

  // Add Qobuz if available and not already present. MB relations are the only source of
  // Qobuz links — the artist URL needs an unguessable numeric ID and every Qobuz search
  // path is robots-disallowed. Authoritative by construction, so no validation needed.
  if (mbData.qobuzUrl && !newPlatforms.some(p => p.sourceId === 'qobuz')) {
    newPlatforms.push({ sourceId: 'qobuz' as SourceId, url: mbData.qobuzUrl });
  }

  // Add library services for artists with pre-2005 releases
  if (mbData.hasPre2005Release) {
    if (!newPlatforms.some(p => p.sourceId === 'hoopla')) {
      newPlatforms.push({
        sourceId: 'hoopla' as SourceId,
        url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(result.name)}&type=music`,
      });
    }
    if (!newPlatforms.some(p => p.sourceId === 'freegal')) {
      newPlatforms.push({
        sourceId: 'freegal' as SourceId,
        url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(result.name)}`,
      });
    }
  }

  // Add social links if available
  if (mbData.socialLinks && mbData.socialLinks.length > 0) {
    for (const social of mbData.socialLinks) {
      const existingIndex = newPlatforms.findIndex(p => p.sourceId === social.platform);
      if (existingIndex === -1) {
        newPlatforms.push({ sourceId: social.platform as SourceId, url: social.url });
      } else {
        const existingUrl = newPlatforms[existingIndex].url.toLowerCase();
        const isExistingSearchUrl = existingUrl.includes('duckduckgo.com') ||
          existingUrl.includes('/search') ||
          existingUrl.includes('?q=') ||
          existingUrl.includes('?query=') ||
          existingUrl.includes('/explore');
        if (isExistingSearchUrl) {
          newPlatforms[existingIndex] = { sourceId: social.platform as SourceId, url: social.url };
        }
      }
    }
  }

  // Add Bandcamp URL from MB platform relations if available
  if (mbData.platformUrls && mbData.platformUrls.length > 0) {
    const bandcampUrl = mbData.platformUrls.find(u => {
      try { return new URL(u).hostname.endsWith('.bandcamp.com'); } catch { return false; }
    });
    if (bandcampUrl) {
      const existingBandcamp = newPlatforms.findIndex(p => p.sourceId === 'bandcamp');
      if (existingBandcamp === -1) {
        newPlatforms.push({ sourceId: 'bandcamp' as SourceId, url: bandcampUrl });
      } else if (isBandcampSearchLink(newPlatforms[existingBandcamp].url)) {
        // Only a "go search Bandcamp yourself" placeholder is worth replacing.
        newPlatforms[existingBandcamp] = { sourceId: 'bandcamp' as SourceId, url: bandcampUrl };
      }
      // Otherwise the existing link came from the probe, which fetched the page and
      // verified the account's identity against the query. An MB relation is a stored
      // string nobody re-checked. Overwriting the verified one with it was how a fan
      // searching "Honeycrush" got sent to a Bandcamp signup form.
    }

    // Add Subvert URL from MB platform relations if available
    const subvertUrl = mbData.platformUrls.find(u => {
      try { const h = new URL(u).hostname; return h === 'www.subvert.fm' || h === 'subvert.fm'; } catch { return false; }
    });
    if (subvertUrl) {
      newPlatforms.push({ sourceId: 'subvert' as SourceId, url: subvertUrl });
    }
  }

  // Sort platforms: real platforms first, then official, then social, then search-only
  const searchOnlyPlatforms = new Set(['ampwall', 'subvert', 'kofi', 'buymeacoffee', 'bandcamp']);
  const officialPlatforms = new Set(['officialsite', 'discogs', 'hoopla', 'freegal']);
  const socialPlatforms = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'peertube']);

  newPlatforms.sort((a, b) => {
    const aIsSocial = socialPlatforms.has(a.sourceId);
    const bIsSocial = socialPlatforms.has(b.sourceId);
    if (aIsSocial && !bIsSocial) return 1;
    if (!aIsSocial && bIsSocial) return -1;
    if (aIsSocial && bIsSocial) {
      const order = ['instagram', 'tiktok', 'youtube', 'peertube', 'threads', 'bluesky', 'mastodon', 'facebook'];
      return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
    }

    const aIsOfficial = officialPlatforms.has(a.sourceId);
    const bIsOfficial = officialPlatforms.has(b.sourceId);
    if (aIsOfficial && bIsOfficial) {
      const order = ['officialsite', 'discogs', 'hoopla', 'freegal'];
      return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
    }
    if (aIsOfficial) return 1;
    if (bIsOfficial) return -1;
    const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
    const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
    if (aIsSearchOnly && !bIsSearchOnly) return 1;
    if (!aIsSearchOnly && bIsSearchOnly) return -1;
    return 0;
  });

  result.platforms = newPlatforms;
  result.wikipediaSummary = mbData.wikipediaSummary || undefined;
  result.wikipediaUrl = mbData.wikipediaUrl || undefined;
  result.location = mbData.location || result.location;
}

// Main search orchestrator
// ---------------------------------------------------------------------------

async function searchAllPlatforms(query: string, mode: SearchMode): Promise<{ results: AggregatedResult[]; enrichmentApplied: boolean }> {
  // Merge overrides come from Supabase and are needed in Phase 2.5 — start the
  // fetch now so it rides along with the platform fan-out instead of adding a
  // round-trip afterwards. getMergeOverrides catches its own errors ([] on failure).
  const overridesPromise = getMergeOverrides();
  // Same for admin link suppressions, applied last (Phase 5).
  const suppressionsPromise = getLinkSuppressions();

  // Phase 1: Search all platforms in parallel and aggregate Bandcamp/Mirlo results
  const [bandcampResults, bandwagonResults, mirloResults, faircampResults, jamcoopResults, patreonResults, ampwallResults, beatportResults, evenResults, musicbrainzResult] = await Promise.allSettled([
    searchBandcamp(query),
    searchBandwagon(query),
    searchMirlo(query),
    searchFaircamp(query),
    searchJamcoop(query),
    searchPatreon(query),
    searchAmpwall(query),
    searchBeatport(query),
    searchEven(query),
    searchMusicBrainz(query),
  ]);

  // UC6: Capture partial platform failures for monitoring
  const platformSettledResults: [string, PromiseSettledResult<unknown>][] = [
    ['bandcamp', bandcampResults],
    ['bandwagon', bandwagonResults],
    ['mirlo', mirloResults],
    ['faircamp', faircampResults],
    ['jamcoop', jamcoopResults],
    ['patreon', patreonResults],
    ['ampwall', ampwallResults],
    ['beatport', beatportResults],
    ['even', evenResults],
    ['musicbrainz', musicbrainzResult],
  ];
  for (const [platform, result] of platformSettledResults) {
    if (result.status === 'rejected') {
      const error = result.reason as Error;
      const errorMessage = error?.message || String(result.reason);
      // Dedupe: only capture once per (platform, error message) pair per 24h
      const shouldCapture = await checkSentryDedup(`uc6:${platform}:${errorMessage}`, 24 * 60 * 60);
      if (shouldCapture) {
        Sentry.captureMessage('Search platform failed', {
          level: 'warning',
          extra: { platform, query, errorMessage },
          tags: { platform },
        });
      }
    }
  }

  // Upstream fetchers (and their caches) always hold the full fuzzy result set;
  // exact mode narrows here, downstream, so both modes share every cache entry.
  const exact = mode === 'exact';

  const allResults: PlatformResult[] = [];
  if (bandcampResults.status === 'fulfilled') allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  if (mirloResults.status === 'fulfilled') {
    const mirloArtists = mirloResults.value.filter(r => r.type === 'artist');
    allResults.push(...(exact ? mirloArtists.filter(r => isExactNameMatch(r.name, query)) : mirloArtists));
  }

  const nameOnlyMapsAll: [string, Map<string, NameOnlyEntry>][] = [
    ['bandwagon', bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map()],
    ['faircamp', faircampResults.status === 'fulfilled' ? faircampResults.value : new Map()],
    ['jamcoop', jamcoopResults.status === 'fulfilled' ? jamcoopResults.value : new Map()],
    ['patreon', patreonResults.status === 'fulfilled' ? patreonResults.value : new Map()],
    ['beatport', beatportResults.status === 'fulfilled' ? beatportResults.value : new Map()],
    ['even', evenResults.status === 'fulfilled' ? evenResults.value : new Map()],
  ];
  const nameOnlyMaps = exact
    ? nameOnlyMapsAll.map(([id, m]) => [id, filterNameOnlyMapToExact(m, query)] as [string, Map<string, NameOnlyEntry>])
    : nameOnlyMapsAll;
  const ampwallMatches = ampwallResults.status === 'fulfilled' ? ampwallResults.value : new Map<string, string>();

  const mbData = musicbrainzResult.status === 'fulfilled' ? musicbrainzResult.value : null;

  // Phase 1.5: Probe Bandcamp for artist names the fan-out discovered.
  // Fuzzy mode only — in exact mode a discovered name that isn't the query is by
  // definition a different artist than the one playing.
  // Candidate order encodes trust: Mirlo and Bandwagon hits are confirmed platform
  // presences; MB suggestions are name-similarity only. Only the first
  // MAX_CANDIDATE_PROBES distinct names are probed.
  if (!exact) {
    const candidateNames: string[] = [];
    if (mirloResults.status === 'fulfilled') {
      candidateNames.push(...mirloResults.value.map(r => r.name));
    }
    if (bandwagonResults.status === 'fulfilled') {
      for (const entry of bandwagonResults.value.values()) {
        if (entry.displayName) candidateNames.push(entry.displayName);
      }
    }
    if (mbData) candidateNames.push(...mbData.suggestedNames);

    const existingBandcampUrls = new Set(
      (bandcampResults.status === 'fulfilled' ? bandcampResults.value : []).map(r => r.url)
    );
    const discoveredBandcamp = await probeBandcampForCandidates(query, candidateNames, existingBandcampUrls);
    allResults.push(...discoveredBandcamp);
  }

  const aggregated = aggregateResults(allResults, query);

  // Phase 2: Attach Ampwall + search-only links
  attachAmpwallAndSearchLinks(aggregated, ampwallMatches, mbData);

  // Phase 2.1: Apply MusicBrainz enrichment (social links, location, Wikipedia, Bandcamp)
  if (mbData && mbData.artistName !== null) {
    applyEnrichmentToResults(aggregated, mbData);
  }

  // Phase 2.2: Create MB fallback result for artists not found on any platform
  // If MusicBrainz has a high-confidence match but no platform result matches,
  // create a result with search-only platforms + MB enrichment data.
  // This ensures prominent artists (like King Gizzard & the Lizard Wizard)
  // are findable even when they're not on any of our indie platforms.
  if (mbData && mbData.artistName !== null) {
    const mbNorm = normalizeForComparison(mbData.artistName);
    // A homonym on a different Bandcamp account does not count as covering this artist.
    // Without that exclusion, refusing to enrich the impostor in Phase 2.1 would delete
    // the real artist from the response entirely rather than listing them separately.
    const existingMatch = aggregated.some(r =>
      r.type === 'artist' &&
      normalizeForComparison(r.name) === mbNorm &&
      !bandcampSubdomainConflicts(mbData.bandcampSubdomain, r.platforms.find(p => p.sourceId === 'bandcamp')?.url)
    );
    if (!existingMatch) {
      const mbPlatforms = [];
      // Add Bandcamp direct URL from MB if available, otherwise search fallback
      if (mbData.bandcampUrl) {
        mbPlatforms.push({ sourceId: 'bandcamp' as SourceId, url: mbData.bandcampUrl });
      } else {
        mbPlatforms.push({ sourceId: 'bandcamp' as SourceId, url: `https://bandcamp.com/search?q=${encodeURIComponent(mbData.artistName)}` });
      }
      mbPlatforms.push(
        { sourceId: 'ampwall' as SourceId, url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(mbData.artistName)}` },
        { sourceId: 'subvert' as SourceId, url: `https://www.subvert.fm/discover?q=${encodeURIComponent(mbData.artistName)}&type=artist` },
        { sourceId: 'kofi' as SourceId, url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(mbData.artistName)}` },
        { sourceId: 'buymeacoffee' as SourceId, url: 'https://buymeacoffee.com/explore-creators' },
      );
      // Add official site, Discogs, social links from enrichment
      if (mbData.officialUrl) {
        mbPlatforms.push({ sourceId: 'officialsite' as SourceId, url: mbData.officialUrl });
      }
      if (mbData.discogsUrl) {
        mbPlatforms.push({ sourceId: 'discogs' as SourceId, url: mbData.discogsUrl });
      }
      if (mbData.qobuzUrl) {
        mbPlatforms.push({ sourceId: 'qobuz' as SourceId, url: mbData.qobuzUrl });
      }
      if (mbData.socialLinks && mbData.socialLinks.length > 0) {
        for (const social of mbData.socialLinks) {
          if (!mbPlatforms.some(p => p.sourceId === social.platform)) {
            mbPlatforms.push({ sourceId: social.platform as SourceId, url: social.url });
          }
        }
      }
      // Sort: direct links before search-only
      const searchOnly = new Set(['ampwall', 'subvert', 'kofi', 'buymeacoffee', 'bandcamp']);
      mbPlatforms.sort((a, b) => {
        const aSearch = searchOnly.has(a.sourceId) && (a.url.includes('/search?') || a.url.includes('duckduckgo') || a.url.includes('/explore') || a.url.includes('/discover')) ? 1 : 0;
        const bSearch = searchOnly.has(b.sourceId) && (b.url.includes('/search?') || b.url.includes('duckduckgo') || b.url.includes('/explore') || b.url.includes('/discover')) ? 1 : 0;
        return aSearch - bSearch;
      });

      // This card exists because MusicBrainz knows the artist and our platforms
      // don't. When MB also handed over their real links, that is the verification
      // — there are no releases to cross-check and nothing to cross-check against.
      const mbConfirmed = musicBrainzConfirmsIdentity(mbData);
      const mbResult: AggregatedResult = {
        id: `mb-${mbNorm}`,
        name: mbData.artistName,
        type: 'artist',
        platforms: mbPlatforms,
        matchConfidence: mbConfirmed ? 'verified' : 'unverified',
        unverifiedReason: mbConfirmed ? undefined : 'no-release-data',
        musicBrainzConfirmed: mbConfirmed,
        location: mbData.location,
        wikipediaSummary: mbData.wikipediaSummary || undefined,
        wikipediaUrl: mbData.wikipediaUrl || undefined,
      };
      aggregated.push(mbResult);
    }
  }

  // Phase 2.5: Apply manual merge overrides before release-based disambiguation.
  // Overrides authoritatively create their own result and strip their URLs
  // from all other results — no reservation needed.
  const overrides = await overridesPromise;
  if (overrides.length > 0) {
    applyMergeOverrides(aggregated, overrides);
  }

  // Phase 3: Fetch releases, then disambiguate using release data
  await fetchReleasesForDisambiguation(aggregated);
  const disambiguated = splitSuspiciousPlatforms(aggregated);
  const merged = mergeByReleaseOverlap(disambiguated);

  // Phase 4: Attach deferred name-only platforms, filter, and sort
  await attachNameOnlyPlatforms(merged, nameOnlyMaps);
  // Re-merge: new results from Phase 4 may overlap with existing ones
  const finalMerged = mergeByReleaseOverlap(merged);

  // Phase 5: Drop admin-suppressed links. Deliberately the last step before
  // filtering — every earlier phase can add links (probe, enrichment, overrides,
  // name-only platforms), and a suppression applied mid-pipeline would be undone
  // by whichever phase ran after it.
  applyLinkSuppressions(finalMerged, await suppressionsPromise);

  const finalResults = filterAndSort(finalMerged, query);
  // Enrichment counts as applied only when the identity matched AND the
  // url-rels data actually arrived. Claiming completion on a partial fetch is
  // how artists shipped without their official site: the client saw
  // hasPendingEnrichment: false and never called Phase 2 to fill the gap.
  const enrichmentApplied = mbData !== null && mbData.artistName !== null && mbData.enrichmentComplete;
  return { results: finalResults, enrichmentApplied };
}

// Shape a DB artist row into a result card. Claimed rows become full profile
// cards (custom image, /a/ page link); verified rows become plain result cards
// with the links a past search persisted, and carry a knownSlug so the
// frontend can link to the pre-generated /artist/ page. Unverified rows are
// rejected — that confidence level is where junk from name-only matches
// accumulates.
export function toStoredResult(
  dbArtist: Awaited<ReturnType<typeof getArtistBySlug>>,
  slug: string,
): AggregatedResult | null {
  if (!dbArtist) return null;
  const claimed = dbArtist.matchConfidence === 'claimed';
  if (!claimed && dbArtist.matchConfidence !== 'verified') return null;
  return {
    // The known- prefix marks a card served from the DB rather than resolved
    // live; the persist step skips these so re-serving stored data can't
    // refresh updated_at and mask genuine staleness.
    id: claimed ? `claimed-${slug}` : `known-${slug}`,
    name: dbArtist.name,
    type: 'artist' as const,
    imageUrl: dbArtist.profile?.customImageUrl || dbArtist.imageUrl,
    platforms: dbArtist.platforms.map(p => ({
      sourceId: p.sourceId as SourceId,
      url: p.url,
      displayName: p.displayName,
      latestRelease: p.latestRelease,
    })),
    matchConfidence: claimed ? ('claimed' as const) : ('verified' as const),
    ...(claimed ? { claimedSlug: slug } : { knownSlug: slug }),
    ...(dbArtist.location ? { location: dbArtist.location } : {}),
  };
}

/**
 * Give every placeable artist result the slug of their page, in place.
 *
 * Without this a native client has no way to reach an artist's releases at all: only
 * `toStoredResult` set a slug, and that runs solely on the DB-served path, so a live-resolved
 * search returned none. Measured on production before the fix — of six real searches only the one
 * *claimed* artist came back with a slug, while all six had rows carrying 16-21 catalogued
 * releases apiece. The data was there; the address for it wasn't.
 *
 * Deriving the slug client-side was the alternative, and is rejected on purpose: `artistSlug`
 * would then have to be reimplemented in Swift and in the extension's JavaScript, which is the
 * same hand-copied-rule drift that `/api/release`'s server-side `payoutPercent` exists to prevent.
 * One definition, on the server.
 *
 * Two rules, both about not handing out an address that 404s:
 * - **Never overwrite.** A claimed artist keeps `claimedSlug`; a stored card keeps its `knownSlug`.
 * - **Skip unverified results.** `persistSearchResults` doesn't write them, so they have no row.
 */
export function attachArtistPageSlugs(results: AggregatedResult[]): void {
  for (const result of results) {
    if (result.type !== 'artist') continue;
    if (result.claimedSlug || result.knownSlug) continue;
    if (result.matchConfidence === 'unverified') continue;
    // The same expression `persistSearchResults` upserts under, so this names a row that exists
    // rather than guessing at one.
    result.knownSlug = artistSlug(result.name);
  }
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // Skip rate limiting when called internally from v1 wrappers (which do their own check).
  // Requires a shared secret to prevent external clients from spoofing this header.
  const internalSecret = process.env.INTERNAL_FUNCTION_SECRET;
  if (!internalSecret || event.headers?.['x-internal-skip-ratelimit'] !== internalSecret) {
    const ip = getClientIp(event.headers || {});
    const rl = await checkRateLimit(ip, 'strict', corsHeaders);
    if (rl.limited) return rl.response;
  }

  const queryResult = validateQuery(event.queryStringParameters?.query);
  if ('error' in queryResult) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: queryResult.error }),
    };
  }
  const query = queryResult.query;

  // 'exact' is sent by playback-detection clients (extension, Mac app), where the
  // query is the artist name from track metadata and partial-name discovery would
  // surface the wrong artist. Anything else — including absence — means a human
  // typed the query, so fuzzy is the default.
  const mode: SearchMode = event.queryStringParameters?.mode === 'exact' ? 'exact' : 'fuzzy';

  try {
    // Normalize the query to handle accented characters (e.g., "Tanerélle" -> "Tanerelle")
    const normalizedQuery = normalizeSearchQuery(query);

    // Known artists are looked up two ways, both concurrent with the platform
    // fan-out: claimed profiles by exact slug of the query (covers queries that
    // ARE the artist's name), and any known artist by name-contains — a partial
    // query like "patrick" must surface Patrick Hardy when a past search already
    // resolved and persisted him, and "lightbulbs" must surface the claimed
    // kid-lightbulbs profile instead of a generic scraped card.
    const slug = artistSlug(normalizedQuery);
    const claimedExactPromise: Promise<AggregatedResult | null> = getArtistBySlug(slug)
      .then(dbArtist => dbArtist?.matchConfidence === 'claimed' ? toStoredResult(dbArtist, slug) : null)
      .catch(err => {
        console.error('[DB] Claimed artist lookup failed:', err);
        return null;
      });
    // Name-contains is a fuzzy-only channel: a detection query IS the artist's
    // exact name, so a known artist merely containing it is someone else.
    const knownByNamePromise: Promise<AggregatedResult[]> = mode === 'exact'
      ? Promise.resolve([])
      : findKnownArtistSlugsByName(normalizedQuery)
        .then(slugs => Promise.all(
          slugs.map(s =>
            getArtistBySlug(s, { allowStale: true })
              .then(dbArtist => toStoredResult(dbArtist, s))
              .catch(() => null)
          )
        ))
        .then(list => list.filter((r): r is AggregatedResult => r !== null))
        .catch(err => {
          console.error('[DB] Known artist name search failed:', err);
          return [];
        });

    const searchResult = await searchAllPlatforms(normalizedQuery, mode);
    const claimedExact = await claimedExactPromise;
    const knownByName = await knownByNamePromise;
    const storedArtists = claimedExact ? [claimedExact, ...knownByName] : knownByName;
    const results = searchResult.results;

    // UC5: Capture zero-result searches for monitoring (volume signal for coverage gaps)
    if (results.length === 0) {
      // Dedupe: only capture once per unique normalized query per 24h
      const shouldCapture = await checkSentryDedup(`uc5:${normalizedQuery}`, 24 * 60 * 60);
      if (shouldCapture) {
        Sentry.captureMessage('Search returned 0 results', {
          level: 'info',
          // The query has to be a TAG, not just an extra. Every zero-result event
          // shares one message, so Sentry folds them into a single issue where
          // `extra` is only readable one event at a time — you can't see which
          // searches came back empty without paging through them. Tags get an
          // aggregated value distribution on the issue page and are searchable
          // (`search_query:radiohead`), which is the whole point of this signal.
          // Both values are already length-capped by validateQuery (200 chars),
          // which is also Sentry's tag-value limit.
          tags: {
            search_query: normalizedQuery,
            // 'exact' means a playback-detection client (extension, Mac app) sent a
            // real artist name and we have no coverage; 'fuzzy' means a human typed
            // it and it may just be a typo. Very different follow-ups.
            search_mode: mode,
          },
          extra: {
            query,
            normalizedQuery,
          },
        });
      }
    }

    // Fold stored artists in: claimed cards replace generic same-name results
    // in place, known artists fill holes the platforms missed.
    const finalResults = mergeStoredArtistsIntoResults(results, storedArtists, normalizedQuery);

    // Persist artist results to the database. Skip claimed results (already in
    // DB) and known- cards (served FROM the DB — persisting them back would
    // refresh updated_at without re-verifying anything).
    try {
      await persistSearchResults(finalResults.filter(r =>
        r.matchConfidence !== 'claimed' && !r.id.startsWith('known-')
      ));
    } catch (err) {
      console.error('[DB] Background persist failed:', err);
    }

    // Tell the client where each artist's page lives.
    //
    // Without this a native client has no way to reach an artist's releases at all: only
    // `toStoredResult` set a slug, and that runs solely on the DB-served path, so a live-resolved
    // search returned none. Measured on production before the fix — of six real searches, only
    // the one *claimed* artist came back with a slug, while all six had rows carrying 16-21
    // catalogued releases apiece. The data was there; the address for it wasn't.
    //
    // Deriving it client-side was the alternative and is rejected on purpose: `artistSlug` would
    // then have to be reimplemented in Swift and in the extension's JavaScript, which is the same
    // hand-copied-rule drift that the release endpoint's server-side `payoutPercent` exists to
    // prevent. One definition, on the server.
    //
    attachArtistPageSlugs(finalResults);

    const response: SearchResponse = {
      query, // Return original query for display
      results: finalResults,
      // Signal client whether enrichment is still pending (true = MB enrichment failed/timed out,
      // client should call /api/search/musicbrainz as fallback; false = enrichment was applied server-side)
      hasPendingEnrichment: !searchResult.enrichmentApplied,
    };

    // Complete responses get a longer CDN life; incomplete ones (enrichment
    // still pending) a short one, so a degraded answer isn't what repeat
    // searchers see for the next five minutes. Both SWR windows are bounded —
    // the old bare `stale-while-revalidate` allowed indefinitely stale
    // responses to keep being served, which let buggy results linger long
    // after the code that produced them was fixed.
    const cacheControl = response.hasPendingEnrichment
      ? 's-maxage=60, stale-while-revalidate=300'
      : 's-maxage=300, stale-while-revalidate=3600';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': cacheControl,
      },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error('Search error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'Failed to search',
        query,
        results: [],
      }),
    };
  }
}
