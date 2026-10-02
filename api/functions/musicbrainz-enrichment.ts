// MusicBrainz enrichment: official site, socials, location, bios, Qobuz and library
// eligibility for the artist a query names.
//
// One implementation, one cache entry, used by both search phases. Phase 1
// (search-sources.ts) applies it server-side when it lands in time; Phase 2
// (search-musicbrainz.ts) is the client's fallback when it didn't. They used to run
// separate copies under separate cache keys, so a Phase 1 that gave up on MusicBrainz
// left nothing behind for Phase 2, and a Phase 2 answer never sped up the next Phase 1.

import { Sentry } from '../lib/sentry';
import { cacheGetOrFetch, artistCacheKey, type PrefetchedCache } from './cache';
import { checkSentryDedup } from './ratelimit';
import {
  normalizeForComparison,
  collectMbSuggestions,
  isCacheableMbResult,
  pickQobuzUrl,
  bandcampSubdomainOf,
  musicBrainzArtistQuery,
} from './search-utils';
import { makeBio, pickBio, type ArtistBio } from '../shared/artist-bio';
import {
  type SocialLink,
  type DiscoveredPlatformLink,
  type ArtistLocation,
  type SocialPlatform,
  type MusicBrainzArea,
  parseSocialUrl,
  fetchDiscogsArtist,
  fetchOfficialSiteSocialLinks,
  mergeSocialLinks,
  searchPeerTubeChannels,
  fetchLinktreeLinks,
  parseMusicBrainzArea,
  pickLocation,
  fetchBandcampPage,
  checkBandcampSubdomain,
  fetchMirloLocation,
  enrichLocationFallback,
  lookupWikipedia,
} from '../search/enrichment';

// On a miss this is the slowest leg of a search, so an answer is kept for a day. Not
// longer: "no such artist" is an answer too, cached as long, and new artists add
// themselves to MusicBrainz all the time — a week left them unenriched for a week.
const MB_ENRICHMENT_CACHE_TTL = 24 * 60 * 60;
// Failures and partial answers: long enough that an outage doesn't cost every search
// the full chain, short enough that a transient blip clears in a minute.
const MB_FAILURE_CACHE_TTL = 60;

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// MusicBrainz enriched result interface with full enrichment data
export interface EnrichedMusicBrainzResult {
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
  /** Sidebar bio from MB's own Bandcamp relation page; '' when it shows none. */
  bandcampBio: string | null;
  /** The Discogs bio, raw markup. */
  discogsProfile: string | null;
  /**
   * A bio source didn't answer (Discogs, Wikipedia or the Bandcamp page). The result is then
   * kept only for the short failure TTL — a timeout must not hide a bio for a day.
   */
  bioFetchFailed: boolean;
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

export function musicBrainzEnrichmentCacheKey(query: string): string {
  return artistCacheKey('mb-enriched', query);
}

// Cached wrapper around the MusicBrainz enrichment fetch, shared by Phase 1 and Phase 2.
// The uncached path costs a rate-limit delay plus several fetches — the single slowest
// leg of a search. Failures and partial enrichments are kept only for the failure TTL
// (see isCacheableMbResult).
export async function getMusicBrainzEnrichment(
  query: string,
  prefetched?: Promise<PrefetchedCache>,
): Promise<{ data: EnrichedMusicBrainzResult; cached: boolean }> {
  return cacheGetOrFetch<EnrichedMusicBrainzResult>(
    musicBrainzEnrichmentCacheKey(query),
    () => fetchMusicBrainzEnrichment(query),
    MB_ENRICHMENT_CACHE_TTL,
    isCacheableMbResult,
    MB_FAILURE_CACHE_TTL,
    prefetched,
  );
}

/**
 * The cached enrichment if there is one, without ever fetching. For a Phase 1 whose
 * client will run Phase 2: on a miss, starting the chain here would only be thrown
 * away when Phase 1 returns, and would compete with Phase 2's own MusicBrainz
 * requests for the same rate limit.
 */
export async function peekMusicBrainzEnrichment(
  query: string,
  prefetched: Promise<PrefetchedCache>,
): Promise<EnrichedMusicBrainzResult | null> {
  const value = (await prefetched).get(musicBrainzEnrichmentCacheKey(query));
  return (value as EnrichedMusicBrainzResult | undefined) ?? null;
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
    bandcampBio: null,
    discogsProfile: null,
    bioFetchFailed: false,
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
      console.log('[MusicBrainz] No results, falling back to Bandcamp/Mirlo location');
      return { ...emptyResult, location: await enrichLocationFallback(query) };
    }

    const artist = artists[0];
    // Only consider exact/near-exact matches for enrichment. Lower-scored hits are
    // still worth reporting as discovery candidates — they just don't get to claim
    // the MB identity (official site, socials, location) for themselves.
    if (artist.score < 95) {
      console.log(`[MusicBrainz] Low confidence match (score ${artist.score}), falling back to Bandcamp/Mirlo location`);
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
      console.log('[MusicBrainz] Top match does not match the query, falling back to Bandcamp/Mirlo location');
      return {
        ...emptyResult,
        suggestedNames: collectMbSuggestions(artists, query),
        location: await enrichLocationFallback(query),
      };
    }

    // Wait 1.1 seconds to respect MusicBrainz rate limit
    await delay(1100);

    // URL relations AND release groups in one lookup. These were two requests with a
    // mandatory 1.1s gap between them; the release groups carry `first-release-date`,
    // which is all the pre-2005 check needs. Phase 2 made the same change first (~1.6s
    // measured there).
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels+release-groups&fmt=json`;

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
    let wikidataUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();
    let platformUrls: string[] = [];

    let mbLocation: ArtistLocation | undefined;
    let hasPre2005Release = false;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: { type: string; url?: { resource: string } }[];
        country?: string;
        area?: MusicBrainzArea;
        'begin-area'?: MusicBrainzArea;
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

      mbLocation = parseMusicBrainzArea(
        artistData.area,
        artistData['begin-area'],
        artistData.country,
      );

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

      // Most artists have a Wikidata relation instead — MusicBrainz moved to those years ago.
      // lookupWikipedia resolves it to the English article when there's no direct link.
      for (const rel of relations) {
        if (rel.type === 'wikidata' && rel.url?.resource) {
          wikidataUrl = rel.url.resource;
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

    // Fetch enrichment data in parallel
    const mirloSlug = artist.name.toLowerCase().replace(/\s+/g, '');
    const [discogsArtist, officialSiteResult, peertubeLink, wikipediaResult, bandcampPage, mirloLocation, bandcampStatus] = await Promise.all([
      discogsUrl ? fetchDiscogsArtist(discogsUrl) : Promise.resolve({ socialLinks: [], profile: null, failed: false }),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null, discoveredPlatforms: [] }),
      searchPeerTubeChannels(artist.name),
      lookupWikipedia(wikipediaUrl, wikidataUrl),
      bandcampUrl ? fetchBandcampPage(bandcampUrl) : Promise.resolve(null),
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

    // One source, whole — never a city from one and a region from another.
    const location = pickLocation(mbLocation, bandcampPage?.location ?? null, mirloLocation);

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
      discogsArtist.socialLinks,
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
      wikipediaSummary: wikipediaResult.status === 'found' ? wikipediaResult.extract : null,
      wikipediaUrl: wikipediaResult.status === 'found' ? wikipediaResult.pageUrl : wikipediaUrl,
      // A retired subdomain's bio belongs to nobody we can link to.
      bandcampBio: bandcampUrl ? bandcampPage?.bio ?? null : null,
      discogsProfile: discogsArtist.profile,
      bioFetchFailed: discogsArtist.failed || wikipediaResult.status === 'failed' || (bandcampUrl !== null && bandcampPage === null),
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


// The Phase 2 response (/api/search/musicbrainz). Its shape predates the shared
// enrichment and is what the web, Mac and extension clients parse, so it stays as is.
export interface MusicBrainzSearchResponse {
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
  /**
   * The Bandcamp subdomain MusicBrainz says is this artist's, even when that account is
   * retired. A client must not merge this enrichment into a result on a different
   * subdomain: that is a same-name stranger (bandcampSubdomainConflicts). Added after
   * the shipped app builds, which ignore it.
   */
  bandcampSubdomain: string | null;
  /**
   * Bio for the MusicBrainz artist: their Bandcamp sidebar, else Discogs, else Wikipedia.
   * Clients use it only to fill a card that has none — Phase 1's sources outrank these, and a
   * claimed artist's card is never filled (they may have turned bios off).
   */
  bio: ArtistBio | null;
  /** A bio source didn't answer. */
  bioFetchFailed: boolean;
}

function isSubvertUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'www.subvert.fm' || hostname === 'subvert.fm';
  } catch {
    return false;
  }
}

/**
 * Shape an enrichment as the Phase 2 response. Null when MusicBrainz itself did not
 * answer — distinct from "no such artist", which is a populated empty response.
 */
export function toMusicBrainzResponse(enrichment: EnrichedMusicBrainzResult): MusicBrainzSearchResponse | null {
  if (enrichment.searchFailed) return null;

  // Phase 1 reads a Subvert relation out of platformUrls itself; Phase 2's clients
  // expect it as a discovered platform.
  const discoveredPlatforms = [...enrichment.discoveredPlatforms];
  const subvertUrl = enrichment.platformUrls.find(isSubvertUrl);
  if (subvertUrl && !discoveredPlatforms.some(p => p.platform === 'subvert')) {
    discoveredPlatforms.push({ platform: 'subvert', url: subvertUrl });
  }

  return {
    query: enrichment.query,
    artistName: enrichment.artistName,
    officialUrl: enrichment.officialUrl,
    discogsUrl: enrichment.discogsUrl,
    hasPre2005Release: enrichment.hasPre2005Release,
    socialLinks: enrichment.socialLinks,
    discoveredPlatforms,
    platformUrls: enrichment.platformUrls,
    wikipediaSummary: enrichment.wikipediaSummary,
    wikipediaUrl: enrichment.wikipediaUrl,
    location: enrichment.location,
    // `?? null`: cache entries written before the field existed lack it.
    bandcampSubdomain: enrichment.bandcampSubdomain ?? null,
    // Bandcamp first — the artist's own words — then Discogs, then Wikipedia. bandcampBio
    // is already null when the subdomain is retired. `?? null`: cache entries written
    // before bios existed lack the fields.
    bio: pickBio([
      makeBio('bandcamp', enrichment.bandcampBio ?? null, enrichment.bandcampUrl),
      makeBio('discogs', enrichment.discogsProfile ?? null, enrichment.discogsUrl),
      makeBio('wikipedia', enrichment.wikipediaSummary, enrichment.wikipediaUrl),
    ]),
    bioFetchFailed: enrichment.bioFetchFailed ?? false,
  };
}
