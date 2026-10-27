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
  pickArtistBandcampUrl,
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
import { fetchCommonsPhoto, type CommonsPhoto, type CommonsPhotoLookup } from '../search/commons-photo';

// On a miss this is the slowest leg of a search, so an answer is kept for a day. Not
// longer: "no such artist" is an answer too, cached as long, and new artists add
// themselves to MusicBrainz all the time — a week left them unenriched for a week.
const MB_ENRICHMENT_CACHE_TTL = 24 * 60 * 60;
// Failures and partial answers: long enough that an outage doesn't cost every search
// the full chain, short enough that a transient blip clears in a minute.
const MB_FAILURE_CACHE_TTL = 60;

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Another artist MusicBrainz lists under exactly the matched artist's name. Only their
 * own links are read (one url-rels lookup each), not the bios and site scraping the
 * matched artist gets: enough to give them a card of their own, and to know the name is
 * shared — which is what stops a name match from passing for an identity match
 * (nameMatchIsSameArtist).
 */
export interface MusicBrainzHomonym {
  mbid: string;
  name: string;
  /** MusicBrainz's own note telling them apart, e.g. "hyperpop artist from LA". */
  disambiguation: string | null;
  officialUrl: string | null;
  /** Their live Bandcamp page; null when MusicBrainz lists none or it is retired. */
  bandcampUrl: string | null;
  /** The account MusicBrainz names for them, kept even when retired — it still says who they are. */
  bandcampSubdomain: string | null;
  socialLinks: SocialLink[];
  platformUrls: string[];
  location: ArtistLocation | undefined;
}

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
  /**
   * The artist's Wikimedia Commons photo (Wikidata P18), with its credit. Only ever shown
   * with that credit, so it never becomes an `imageUrl`. See api/search/commons-photo.ts.
   */
  commonsPhoto: CommonsPhoto | null;
  /** Commons or Wikidata didn't answer. Kept only for the failure TTL, like bioFetchFailed. */
  photoFetchFailed: boolean;
  location: ArtistLocation | undefined;
  /**
   * Partial-match artist names from MB's ranked search results (beyond the top
   * hit), e.g. "Goodnight Argent" for the query "argent". Discovery candidates
   * only — they are verified against Bandcamp before becoming results.
   */
  suggestedNames: string[];
  /**
   * Other artists with exactly this name, best-ranked first. Empty for most artists.
   * Absent from cache entries written before it existed, so read it with `?? []`.
   */
  homonyms: MusicBrainzHomonym[];
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

const MUSICBRAINZ_HEADERS = {
  'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
};

// How many same-name artists get their links looked up. Each lookup is a MusicBrainz
// request behind a 1.1s rate-limit gap, and on a miss a caller that doesn't defer waits
// for it. Any further ones still mark the name as shared; they just get no card.
const MAX_HOMONYM_LOOKUPS = 2;

// Only these are looked up. MusicBrainz also files entries with no type, "Other" or
// "Character" — Paracosm's third is a "digital design" entry with an Instagram and no
// releases — and a card for one of those is noise. They still mark the name as shared.
const PERFORMER_TYPES = new Set(['Person', 'Group', 'Orchestra', 'Choir']);

type MusicBrainzSearchHit = {
  id: string;
  name: string;
  score: number;
  type?: string | null;
  disambiguation?: string;
  country?: string;
  area?: MusicBrainzArea;
  'begin-area'?: MusicBrainzArea;
};

type MusicBrainzRelation = { type: string; url?: { resource: string } };

interface ArtistRelations {
  officialUrl: string | null;
  discogsUrl: string | null;
  bandcampUrl: string | null;
  wikipediaUrl: string | null;
  wikidataUrl: string | null;
  linktreeUrl: string | null;
  socialLinks: SocialLink[];
  /** Bandcamp, streaming and store relations: what disambiguation compares cards against. */
  platformUrls: string[];
}

const PLATFORM_RELATION_TYPES = new Set([
  'bandcamp', 'streaming music', 'purchase for download',
  'download for free', 'free streaming',
]);

/** The links an artist's MusicBrainz url-rels name. */
function readArtistRelations(relations: MusicBrainzRelation[]): ArtistRelations {
  const found: ArtistRelations = {
    officialUrl: null,
    discogsUrl: null,
    bandcampUrl: null,
    wikipediaUrl: null,
    wikidataUrl: null,
    linktreeUrl: null,
    socialLinks: [],
    platformUrls: [],
  };
  const seenPlatforms = new Set<SocialPlatform>();

  for (const rel of relations) {
    const url = rel.url?.resource;
    if (!url) continue;

    if (rel.type === 'official homepage') found.officialUrl ??= url;
    if (rel.type === 'discogs') found.discogsUrl ??= url;
    // Most artists have a Wikidata relation rather than a Wikipedia one — MusicBrainz moved
    // to those years ago. lookupWikipedia resolves it to the English article.
    if (rel.type === 'wikipedia' && url.includes('en.wikipedia.org')) found.wikipediaUrl ??= url;
    if (rel.type === 'wikidata') found.wikidataUrl ??= url;
    if (PLATFORM_RELATION_TYPES.has(rel.type)) found.platformUrls.push(url);

    if (rel.type === 'social network' || rel.type === 'youtube') {
      if (url.includes('linktr.ee')) {
        if (!found.linktreeUrl) console.log(`[MusicBrainz] Found Linktree: ${url}`);
        found.linktreeUrl ??= url;
        continue;
      }
      const socialLink = parseSocialUrl(url);
      if (socialLink && !seenPlatforms.has(socialLink.platform)) {
        seenPlatforms.add(socialLink.platform);
        found.socialLinks.push(socialLink);
      }
    }
  }

  // A 'bandcamp' relation wins; failing that, any relation that points at a Bandcamp page.
  found.bandcampUrl =
    relations.find(rel => rel.type === 'bandcamp' && rel.url?.resource)?.url?.resource ??
    relations.find(rel => bandcampSubdomainOf(rel.url?.resource) !== null)?.url?.resource ??
    null;

  return found;
}

/**
 * The other artists in MusicBrainz's ranked results with exactly the matched artist's
 * name and the same confidence bar, best-ranked first.
 */
export function sameNameHits<T extends { id: string; name: string; score: number }>(hits: T[], matched: T): T[] {
  const name = normalizeForComparison(matched.name);
  return hits.filter(hit => hit.id !== matched.id && hit.score >= 95 && normalizeForComparison(hit.name) === name);
}

/**
 * Each same-name artist's own links. `complete` is false when a lookup failed: that artist's
 * links are unknown, not absent, and the enrichment must not be cached as if they were.
 */
async function lookupHomonyms(hits: MusicBrainzSearchHit[]): Promise<{ homonyms: MusicBrainzHomonym[]; complete: boolean }> {
  const homonyms: MusicBrainzHomonym[] = [];
  let complete = true;
  let lookups = 0;

  for (const hit of hits) {
    const homonym: MusicBrainzHomonym = {
      mbid: hit.id,
      name: hit.name,
      disambiguation: hit.disambiguation || null,
      officialUrl: null,
      bandcampUrl: null,
      bandcampSubdomain: null,
      socialLinks: [],
      platformUrls: [],
      location: parseMusicBrainzArea(hit.area, hit['begin-area'], hit.country),
    };
    homonyms.push(homonym);
    if (lookups >= MAX_HOMONYM_LOOKUPS || !PERFORMER_TYPES.has(hit.type ?? '')) continue;
    lookups++;

    await delay(1100);
    try {
      const response = await globalThis.fetch(
        `https://musicbrainz.org/ws/2/artist/${hit.id}?inc=url-rels&fmt=json`,
        { headers: MUSICBRAINZ_HEADERS },
      );
      if (!response.ok) {
        console.log(`[MusicBrainz] Homonym lookup failed for ${hit.id}: ${response.status}`);
        complete = false;
        continue;
      }
      const data = await response.json() as { relations?: MusicBrainzRelation[] };
      const relations = readArtistRelations(data.relations || []);

      homonym.officialUrl = relations.officialUrl;
      homonym.socialLinks = relations.socialLinks;
      homonym.platformUrls = relations.platformUrls;
      homonym.bandcampSubdomain = bandcampSubdomainOf(relations.bandcampUrl);
      // A retired account is dropped as it is for the matched artist, but its claim stays.
      if (relations.bandcampUrl && (await checkBandcampSubdomain(relations.bandcampUrl)) === 'dead') {
        homonym.platformUrls = relations.platformUrls.filter(u => u !== relations.bandcampUrl);
      } else {
        homonym.bandcampUrl = relations.bandcampUrl;
      }
    } catch (error) {
      console.log(`[MusicBrainz] Homonym lookup error for ${hit.id}:`, (error as Error)?.message);
      complete = false;
    }
  }

  return { homonyms, complete };
}

/**
 * A same-name artist in the shape the search pipeline merges MusicBrainz data in, so they
 * go through the same matching and get the same kind of card as the matched artist. Only
 * their own links: no bios, photos or library eligibility, which were never fetched.
 */
export function homonymAsEnrichment(homonym: MusicBrainzHomonym, query: string): EnrichedMusicBrainzResult {
  return {
    query,
    artistName: homonym.name,
    officialUrl: homonym.officialUrl,
    discogsUrl: null,
    bandcampUrl: homonym.bandcampUrl,
    bandcampSubdomain: homonym.bandcampSubdomain,
    qobuzUrl: pickQobuzUrl(homonym.platformUrls),
    hasPre2005Release: false,
    socialLinks: homonym.socialLinks,
    discoveredPlatforms: [],
    platformUrls: homonym.platformUrls,
    wikipediaSummary: null,
    wikipediaUrl: null,
    bandcampBio: null,
    discogsProfile: null,
    bioFetchFailed: false,
    commonsPhoto: null,
    photoFetchFailed: false,
    location: homonym.location,
    suggestedNames: [],
    homonyms: [],
    searchFailed: false,
    enrichmentComplete: true,
  };
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
    commonsPhoto: null,
    photoFetchFailed: false,
    location: undefined,
    suggestedNames: [],
    homonyms: [],
    searchFailed: false,
    enrichmentComplete: true,
  };

  try {
    // Search for artist. MB is Lucene-backed and its ranked list is the one real
    // search engine in the fan-out: the top hit drives enrichment (strict gates
    // below), the rest become discovery candidates via collectMbSuggestions.
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(musicBrainzArtistQuery(query))}&fmt=json&limit=5`;

    const response = await globalThis.fetch(searchUrl, { headers: MUSICBRAINZ_HEADERS });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return { ...emptyResult, searchFailed: true };
    }

    const data = await response.json() as { artists?: MusicBrainzSearchHit[] };
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

    const artistResponse = await globalThis.fetch(artistUrl, { headers: MUSICBRAINZ_HEADERS });

    // Started now, after the lookup above, so its own 1.1s gaps keep MusicBrainz's rate
    // limit; it then runs alongside the Discogs, Wikipedia and site fetches below, which
    // don't touch MusicBrainz.
    const homonymsPromise = lookupHomonyms(sameNameHits(artists, artist));

    let officialUrl: string | null = null;
    let discogsUrl: string | null = null;
    let bandcampUrl: string | null = null;
    let qobuzUrl: string | null = null;
    let linktreeUrl: string | null = null;
    let wikipediaUrl: string | null = null;
    let wikidataUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
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

      const relations = readArtistRelations(artistData.relations || []);
      ({ officialUrl, discogsUrl, bandcampUrl, wikipediaUrl, wikidataUrl, linktreeUrl } = relations);
      socialLinks.push(...relations.socialLinks);
      platformUrls = relations.platformUrls;
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
    const [discogsArtist, officialSiteResult, peertubeLink, wikipediaResult, bandcampPage, mirloLocation, bandcampStatus, commonsPhoto] = await Promise.all([
      discogsUrl ? fetchDiscogsArtist(discogsUrl) : Promise.resolve({ socialLinks: [], profile: null, failed: false }),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve({ socialLinks: [], linktreeUrl: null, discoveredPlatforms: [], bandcampUrls: [] }),
      searchPeerTubeChannels(artist.name),
      lookupWikipedia(wikipediaUrl, wikidataUrl),
      bandcampUrl ? fetchBandcampPage(bandcampUrl) : Promise.resolve(null),
      fetchMirloLocation(mirloSlug),
      // Rides in this existing parallel block, so a confirmed-dead link costs no
      // extra wall-clock — and only runs at all when MB actually has a Bandcamp rel.
      bandcampUrl ? checkBandcampSubdomain(bandcampUrl) : Promise.resolve('unknown' as const),
      wikidataUrl ? fetchCommonsPhoto(wikidataUrl) : Promise.resolve<CommonsPhotoLookup>({ status: 'none' }),
    ]);
    const homonymLookup = await homonymsPromise;

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
    let linktreeBandcampUrls: string[] = [];
    const finalLinktreeUrl = linktreeUrl || officialSiteResult.linktreeUrl;
    if (finalLinktreeUrl) {
      const linktree = await fetchLinktreeLinks(finalLinktreeUrl);
      linktreeSocialLinks = linktree.socialLinks;
      linktreeBandcampUrls = linktree.bandcampUrls;
    }

    // No live Bandcamp from MusicBrainz — none listed, or the listed one retired: take the
    // account the artist's own site or Linktree links, if it carries their name. That is how
    // Honeycrush (Brooklyn) is found at `honeycrush-online` while MB still lists the retired
    // `honeyyycrush`; nothing derived from the name could guess it. Still checked for
    // retirement — a site can be as out of date as MusicBrainz.
    let siteBandcampUrl: string | null = null;
    if (!bandcampUrl) {
      const candidate = pickArtistBandcampUrl([...officialSiteResult.bandcampUrls, ...linktreeBandcampUrls], artist.name);
      if (candidate && (await checkBandcampSubdomain(candidate)) !== 'dead') {
        console.log(`[MusicBrainz] Using Bandcamp from "${artist.name}"'s own site or Linktree: ${candidate}`);
        siteBandcampUrl = candidate;
        // platformUrls is where both the server and the web client read MB's Bandcamp from.
        platformUrls = [...platformUrls, candidate];
      }
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
      bandcampUrl: bandcampUrl ?? siteBandcampUrl,
      // The account the artist is on now when their site names one; otherwise MB's claim,
      // kept even when retired, since it still says which account is theirs.
      bandcampSubdomain: bandcampSubdomainOf(siteBandcampUrl ?? mbClaimedBandcampUrl),
      qobuzUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
      discoveredPlatforms: officialSiteResult.discoveredPlatforms,
      platformUrls,
      wikipediaSummary: wikipediaResult.status === 'found' ? wikipediaResult.extract : null,
      wikipediaUrl: wikipediaResult.status === 'found' ? wikipediaResult.pageUrl : wikipediaUrl,
      // A retired subdomain's bio belongs to nobody we can link to. A site-sourced account's
      // page was never fetched, so it has no bio here (and that isn't a failure).
      bandcampBio: bandcampUrl ? bandcampPage?.bio ?? null : null,
      discogsProfile: discogsArtist.profile,
      bioFetchFailed: discogsArtist.failed || wikipediaResult.status === 'failed' || (bandcampUrl !== null && bandcampPage === null),
      commonsPhoto: commonsPhoto.status === 'found' ? commonsPhoto.photo : null,
      photoFetchFailed: commonsPhoto.status === 'failed',
      location,
      suggestedNames: collectMbSuggestions(artists, query, artist.name),
      homonyms: homonymLookup.homonyms,
      searchFailed: false,
      // A homonym whose links didn't arrive could be the very artist the fan is after, so a
      // failed lookup leaves enrichment pending like a failed lookup of the matched artist.
      enrichmentComplete: artistResponse.ok && homonymLookup.complete,
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
  /**
   * A Wikimedia Commons photo of the MusicBrainz artist. Clients show it only on a card with no
   * photo of its own, and only beside its credit (author, licence, link to the file page).
   * Added after the shipped app builds, which ignore it.
   */
  commonsPhoto: CommonsPhoto | null;
  /**
   * Other artists MusicBrainz lists under exactly this name. When there are any, a name match
   * is not evidence that a card is `artistName`: a client merges this enrichment only into a
   * card on the same Bandcamp account (nameMatchIsSameArtist), and gives each homonym
   * with links a card of their own. Added after the shipped app builds, which ignore it.
   */
  homonyms: MusicBrainzHomonym[];
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
    // `?? null`: cache entries written before photos existed lack the field.
    commonsPhoto: enrichment.commonsPhoto ?? null,
    // `?? []`: cache entries written before homonyms existed lack the field.
    homonyms: enrichment.homonyms ?? [],
  };
}
