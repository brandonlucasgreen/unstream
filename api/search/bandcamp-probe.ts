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
  parseBandcampReleaseCounts,
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
}

const DEFAULT_BUDGET_MS = 5000;
const MIN_REQUEST_MS = 1200;

interface CandidateOutcome {
  verdict: Exclude<BandcampProbeVerdict, 'absent'>;
  identity?: { id: number; name: string };
  counts: { albums: number; tracks: number };
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
  return { verdict: 'accepted', identity, counts };
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
    return { verdict: 'absent', artistUrl: null, ...empty };
  }

  const deadline = Date.now() + budgetMs;
  // Rejections are remembered so a later 'absent' can't overwrite a more
  // specific reason; 'undecided' outranks both so we never cache a false miss.
  let fallback: BandcampProbeResult = { verdict: 'absent', artistUrl: null, ...empty };
  let sawUndecided = false;

  for (const slug of candidates) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_REQUEST_MS) {
      // Out of budget with candidates left — that's unknown, not a miss.
      sawUndecided = true;
      break;
    }

    let outcome: CandidateOutcome | null;
    try {
      outcome = await probeCandidate(slug, remaining);
    } catch {
      // Network error or abort. Unknown, not a miss.
      sawUndecided = true;
      continue;
    }

    if (outcome === null) continue; // 404 — try the next candidate

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
    };
  }

  if (sawUndecided && fallback.verdict === 'absent') {
    return { verdict: 'undecided', artistUrl: null, ...empty };
  }
  return fallback;
}

/**
 * Cached artist-URL lookup. Replaces the blocked bandcamp.com/search scrape.
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
export async function findBandcampArtistUrl(
  query: string,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<string | null> {
  const queryNorm = normalizeForComparison(query);
  if (!queryNorm) return null;

  const cached = await getBandcampProbe(queryNorm);
  if (cached) return cached.artist_url;

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
  });

  return result.artistUrl;
}
