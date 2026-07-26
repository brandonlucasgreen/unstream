// Find a Bandcamp artist URL by probing candidate subdomains.
//
// bandcamp.com/search is behind a Fastly bot challenge and is Disallow'ed in
// Bandcamp's robots.txt, so it cannot be used to look artists up. Instead we
// derive candidate slugs from the artist name and ask <slug>.bandcamp.com/music
// directly — a path robots.txt permits.
//
// One request per candidate answers everything we need:
//   - HTTP 404                      -> no such account
//   - data-band="{id,name}"         -> authoritative identity
//   - .music-grid-item data-item-id -> album / track counts
//
// Both verification steps are load-bearing. A slug existing does not mean it is
// the right artist (thebeths.bandcamp.com is an unrelated account named "no
// content"), and a matching name does not mean it is a real presence — the
// accounts at beyonce, sufjan and jackwhite all match by name and hold no
// releases at all. The real Jack White is at officialjackwhite.
//
// See docs/specs/bandcamp-coverage-research.md for the measurements behind this.

import { Sentry } from '../lib/sentry';
import { getBandcampProbe, putBandcampProbe } from '../functions/db';
import { isUrlHostnameAllowed } from '../functions/middleware';
import { checkSentryDedup } from '../functions/ratelimit';
import {
  bandcampSlugCandidates,
  namesMatch,
  normalizeForComparison,
} from '../functions/search-utils';
import {
  isBandcampChallenge,
  parseBandcampBandIdentity,
  parseBandcampImage,
  parseBandcampPageLocation,
  parseBandcampReleaseCounts,
  parseBandcampReleaseTitles,
} from '../functions/search-parsers';

/**
 * Outcome of probing for an artist.
 *
 * `undecided` means we could not find out — a network error, a timeout, or a bot
 * challenge. It is deliberately NOT a value the cache accepts: caching it would
 * turn a transient outage into a permanent "this artist isn't on Bandcamp".
 */
export type BandcampProbeVerdict =
  | 'accepted'
  | 'absent'
  | 'rejected_empty'
  | 'rejected_name'
  | 'undecided';

export interface BandcampProbeResult {
  verdict: BandcampProbeVerdict;
  /** Resolved artist URL. Non-null only when verdict is 'accepted'. */
  artistUrl: string | null;
  bandName?: string;
  bandId?: number;
  albumCount: number;
  trackCount: number;
  matchedSlug?: string;
  /**
   * Raw location string from the same /music response, e.g. "Northampton, Massachusetts".
   * Free — the page is already in hand — so callers never need a second fetch just for it.
   */
  location?: string;
  /**
   * Normalized release titles from the same /music response.
   *
   * Also free, and load-bearing: disambiguation fetches release data inside one fixed 4s
   * race, so a Bandcamp platform arriving without titles forces two more requests into
   * that budget and starves every other artist's lookups.
   */
  releaseTitles?: string[];
  /** Artist photo from the page's og:image. Replaced Qobuz as the image source. */
  imageUrl?: string;
  /**
   * Slug candidates actually attempted, in order.
   *
   * Cached so a negative can be reused only for queries whose candidates it covers.
   * `query_norm` strips punctuation, so "Morice" (['morice']) and "Mo-Rice"
   * (['morice', 'mo-rice']) share a cache row — without this the first spelling's
   * miss answers for the second and hides a real artist.
   */
  probedSlugs: string[];
}

const DEFAULT_BUDGET_MS = 5000;
const MIN_REQUEST_MS = 1200;

interface CandidateOutcome {
  verdict: Exclude<BandcampProbeVerdict, 'absent'>;
  identity?: { id: number; name: string };
  counts: { albums: number; tracks: number };
  location?: string;
  releaseTitles?: string[];
  imageUrl?: string;
  /** Bandcamp asked us to back off. Stop the whole round, don't try more candidates. */
  rateLimited?: boolean;
}

/** Fetch and classify a single candidate slug. Returns null if the slug has no account. */
async function probeCandidate(slug: string, timeoutMs: number): Promise<CandidateOutcome | null> {
  const url = `https://${slug}.bandcamp.com/music`;

  // Slugs come from normalizeForComparison / accent-stripping, so they contain
  // only [a-z0-9-] and cannot alter the host. Validated anyway as defence in depth.
  if (!isUrlHostnameAllowed(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Unstream/1.0 (+https://unstream.stream)' },
    });
  } finally {
    clearTimeout(timeout);
  }

  // No such account. This is a real answer, not a failure.
  if (response.status === 404) return null;

  // Bandcamp does rate-limit, and firing the remaining candidates into an active
  // 429 is both rude and pointless. Flag it so the caller abandons the round.
  if (response.status === 429 || response.status === 503) {
    const shouldCapture = await checkSentryDedup('uns152:bandcamp-rate-limited', 60 * 60);
    if (shouldCapture) {
      Sentry.captureMessage('Bandcamp rate-limited the probe', {
        level: 'warning',
        extra: { url, status: response.status, retryAfter: response.headers.get('retry-after') },
        tags: { platform: 'bandcamp' },
      });
    }
    return { verdict: 'undecided', counts: { albums: 0, tracks: 0 }, rateLimited: true };
  }

  if (!response.ok) return { verdict: 'undecided', counts: { albums: 0, tracks: 0 } };

  const html = await response.text();

  if (isBandcampChallenge(html)) {
    const shouldCapture = await checkSentryDedup('uns152:bandcamp-music-challenge', 6 * 60 * 60);
    if (shouldCapture) {
      Sentry.captureMessage('Bandcamp /music blocked by bot challenge', {
        level: 'warning',
        extra: { url, responseBytes: html.length },
        tags: { platform: 'bandcamp' },
      });
    }
    return { verdict: 'undecided', counts: { albums: 0, tracks: 0 } };
  }

  const identity = parseBandcampBandIdentity(html);
  // A 200 with no identity block isn't a page we understand; don't treat it as absent.
  if (!identity) return { verdict: 'undecided', counts: { albums: 0, tracks: 0 } };

  const counts = parseBandcampReleaseCounts(html);
  const location = parseBandcampPageLocation(html) ?? undefined;
  const releaseTitles = parseBandcampReleaseTitles(html);
  const imageUrl = parseBandcampImage(html) ?? undefined;
  return { verdict: 'accepted', identity, counts, location, releaseTitles, imageUrl };
}

/**
 * Probe up to three candidate slugs for `query` and return the first verified match.
 *
 * Stops at the first acceptance. If no candidate is accepted, reports the most
 * informative rejection so the cache records *why* — and so an 'undecided' is
 * never mistaken for a genuine miss.
 */
export async function probeBandcampArtist(
  query: string,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<BandcampProbeResult> {
  const candidates = bandcampSlugCandidates(query);
  const empty = { albumCount: 0, trackCount: 0 };
  if (candidates.length === 0) {
    return { verdict: 'absent', artistUrl: null, ...empty, probedSlugs: [] };
  }

  const deadline = Date.now() + budgetMs;
  // Rejections are remembered so a later 'absent' can't overwrite a more
  // specific reason; 'undecided' outranks both so we never cache a false miss.
  let fallback: BandcampProbeResult = { verdict: 'absent', artistUrl: null, ...empty, probedSlugs: [] };
  let sawUndecided = false;
  // Only the slugs we really requested. A round cut short by budget or a 429 must not
  // claim coverage it does not have.
  const probedSlugs: string[] = [];

  for (const slug of candidates) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_REQUEST_MS) {
      // Out of budget with candidates left — that's unknown, not a miss.
      sawUndecided = true;
      break;
    }

    let outcome: CandidateOutcome | null;
    probedSlugs.push(slug);
    try {
      outcome = await probeCandidate(slug, remaining);
    } catch {
      // Network error or abort. Unknown, not a miss.
      sawUndecided = true;
      continue;
    }

    if (outcome === null) continue; // 404 — try the next candidate

    // Back off immediately rather than spending the remaining candidates on a
    // service that has just told us to stop.
    if (outcome.rateLimited) {
      return { verdict: 'undecided', artistUrl: null, ...empty, probedSlugs };
    }

    if (outcome.verdict === 'undecided' || !outcome.identity) {
      sawUndecided = true;
      continue;
    }

    const { identity, counts } = outcome;

    if (!namesMatch(identity.name, query)) {
      if (fallback.verdict === 'absent') {
        fallback = {
          verdict: 'rejected_name',
          artistUrl: null,
          bandName: identity.name,
          bandId: identity.id,
          albumCount: counts.albums,
          trackCount: counts.tracks,
          matchedSlug: slug,
          probedSlugs,
        };
      }
      continue;
    }

    // Name matches but the account holds nothing — a parked squatter.
    if (counts.albums === 0 && counts.tracks === 0) {
      fallback = {
        verdict: 'rejected_empty',
        artistUrl: null,
        bandName: identity.name,
        bandId: identity.id,
        albumCount: 0,
        trackCount: 0,
        matchedSlug: slug,
        probedSlugs,
      };
      continue;
    }

    return {
      verdict: 'accepted',
      artistUrl: `https://${slug}.bandcamp.com`,
      bandName: identity.name,
      bandId: identity.id,
      albumCount: counts.albums,
      trackCount: counts.tracks,
      matchedSlug: slug,
      location: outcome.location,
      releaseTitles: outcome.releaseTitles,
      imageUrl: outcome.imageUrl,
      probedSlugs,
    };
  }

  if (sawUndecided && fallback.verdict === 'absent') {
    return { verdict: 'undecided', artistUrl: null, ...empty, probedSlugs };
  }
  return { ...fallback, probedSlugs };
}

/** What a cached lookup yields for an artist that is on Bandcamp. */
export interface BandcampArtistMatch {
  url: string;
  bandName: string | null;
  /** Raw location string as Bandcamp renders it, e.g. "Oxford, UK". */
  location: string | null;
  /** Normalized release titles, so disambiguation need not refetch /music. */
  releaseTitles: string[];
  /** Artist photo (og:image), or null when the page shows none. */
  imageUrl: string | null;
}

/**
 * Cached artist lookup. Replaces the blocked bandcamp.com/search scrape.
 *
 * Every distinct query costs at most one round of probes, ever — negatives are
 * cached too, so repeated searches for an artist who isn't on Bandcamp are free
 * after the first. Undecided outcomes are never cached, so a transient failure
 * doesn't become a permanent miss.
 *
 * `budgetMs` caps the whole probe round, not each request. Callers running inside
 * a Netlify function's 10s ceiling should pass their own budget rather than take
 * the default — measured latency is 270-980ms, but the cap is what bounds the bad
 * case if Bandcamp is slow.
 */
export async function findBandcampArtist(
  query: string,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<BandcampArtistMatch | null> {
  const queryNorm = normalizeForComparison(query);
  if (!queryNorm) return null;

  // The cache key drops punctuation, so it cannot distinguish "Morice" from
  // "Mo-Rice" — but their candidate sets differ. Pass the candidates so a negative
  // recorded for a narrower set is not reused for a wider one.
  const cached = await getBandcampProbe(queryNorm, bandcampSlugCandidates(query));
  if (cached) {
    return cached.artist_url
      ? {
          url: cached.artist_url,
          bandName: cached.band_name,
          location: cached.location,
          releaseTitles: cached.release_titles ?? [],
          imageUrl: cached.image_url,
        }
      : null;
  }

  const result = await probeBandcampArtist(query, budgetMs);

  // Don't know != not there. Leave the cache empty so we retry next time.
  if (result.verdict === 'undecided') return null;

  await putBandcampProbe({
    query_norm: queryNorm,
    artist_url: result.artistUrl,
    band_name: result.bandName ?? null,
    band_id: result.bandId ?? null,
    album_count: result.albumCount,
    track_count: result.trackCount,
    matched_slug: result.matchedSlug ?? null,
    verdict: result.verdict,
    location: result.location ?? null,
    release_titles: result.releaseTitles ?? null,
    image_url: result.imageUrl ?? null,
    probed_slugs: result.probedSlugs,
  });

  return result.artistUrl
    ? {
        url: result.artistUrl,
        bandName: result.bandName ?? null,
        location: result.location ?? null,
        releaseTitles: result.releaseTitles ?? [],
        imageUrl: result.imageUrl ?? null,
      }
    : null;
}

/** Convenience wrapper for callers that only want the URL. */
export async function findBandcampArtistUrl(
  query: string,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<string | null> {
  return (await findBandcampArtist(query, budgetMs))?.url ?? null;
}
