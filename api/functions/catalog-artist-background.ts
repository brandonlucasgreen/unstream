// Netlify Background Function: build an artist's release catalog from Bandcamp.
//
// Invoked by requestArtistCatalog() when a fan saves an artist or a search resolves one.
// Runs off the request path — a `-background` function returns 202 to its caller immediately
// and then runs for up to 15 minutes — so nothing here is on a user's critical path. That
// matters: cataloging one artist costs one Bandcamp request, and the search that triggered it
// must not wait for it.
//
// Authenticated with a shared secret. The Discord background function in this repo has no
// auth, and copying that here would be a mistake: an open endpoint that makes Unstream crawl
// Bandcamp on demand is exactly the amplifier the check-releases hardening existed to close.

import { timingSafeEqual } from 'crypto';
import {
  claimArtistForCatalog,
  getArtistBandcampUrl,
  persistReleaseDetail,
  persistReleases,
  recordCatalogOutcome,
  type CatalogTrigger,
  type PersistedRelease,
} from './db';
import { isUrlHostnameAllowed } from './middleware';
import { safeFetch, safeHostname } from './safe-fetch';
import { bandcampMusicUrl, ingestBandcampDetail, ingestBandcampGrid } from './release-ingest';

/** Ceiling on artists per invocation, so one call can't become an unbounded crawl. */
const MAX_ARTISTS_PER_RUN = 25;

/** Pause between artists. One Bandcamp request each, spaced out rather than in a burst. */
const DELAY_BETWEEN_ARTISTS_MS = 1_000;

// --- Detail-pass budgets -----------------------------------------------------
//
// The grid is one request for a whole discography. Dates, formats and prices are one request
// *per release*, and they're the data the feature actually rests on, so the pass has to happen
// — but a blanket sweep of ~800 artists × ~20 releases would be 16,000 requests, which is a
// crawl programme, not a parser change. Four limits keep it a trickle:

/** Newest-first, so a large discography gets its recent releases priced on the first run. */
const MAX_DETAIL_FETCHES_PER_ARTIST = 20;

/** Invocation-wide, so a 25-artist batch can't multiply into hundreds of requests. */
const MAX_DETAIL_FETCHES_PER_RUN = 100;

/** Roughly one request per second sustained — far below what one browser page load costs. */
const DELAY_BETWEEN_DETAIL_FETCHES_MS = 1_000;

/**
 * Stop starting detail fetches this long into the invocation. Netlify background functions get
 * 15 minutes; leaving headroom means a run ends by finishing rather than by being killed
 * mid-write.
 */
const DETAIL_BUDGET_MS = 9 * 60_000;

/**
 * Re-read a release page after this long. Prices change and vinyl sells out, so an offer is a
 * claim with an age — but re-reading weekly would triple the crawl for data that rarely moves.
 */
const DETAIL_REFRESH_DAYS = 30;

/** What's left of the invocation's detail allowance. Shared across every artist in the batch. */
interface DetailBudget {
  fetchesLeft: number;
  deadline: number;
}

function isAuthorized(header: string | undefined): boolean {
  // Reuses the secret this repo already has for internal function-to-function calls
  // (resolve-url, search-sources, and both v1 wrappers). A second near-identically-named
  // variable would be a footgun, and the blast radius of this one is small: cooldown and
  // hourly caps are enforced inside this function regardless of who calls it, and only
  // artists already in our database can be named.
  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  // No secret configured means the endpoint is closed, not open.
  if (!secret) {
    console.error('[catalog] INTERNAL_FUNCTION_SECRET is not set — refusing all requests');
    return false;
  }
  if (!header?.startsWith('Bearer ')) return false;

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function handler(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: '' };
  }

  if (!isAuthorized(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: '' };
  }

  // Production only, checked here as well as in request-catalog.ts. The caller-side gate stops
  // a preview from asking; this one means the guarantee holds no matter who asks, since this
  // function is what actually writes to the production database. Cheap, and the alternative is
  // a rule that's true only as long as every future caller remembers it.
  if (process.env.CONTEXT !== 'production') {
    console.log(`[catalog] refusing — context is ${process.env.CONTEXT ?? 'unset'}, not production`);
    return { statusCode: 403, body: JSON.stringify({ skipped: 'non-production context' }) };
  }

  let body: { artistIds?: unknown; trigger?: unknown };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: '' };
  }

  const artistIds = Array.isArray(body.artistIds)
    ? body.artistIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_ARTISTS_PER_RUN)
    : [];
  const trigger: CatalogTrigger = body.trigger === 'saved' ? 'saved' : 'searched';

  if (artistIds.length === 0) return { statusCode: 400, body: '' };

  let catalogued = 0;
  let skipped = 0;
  const budget: DetailBudget = {
    fetchesLeft: MAX_DETAIL_FETCHES_PER_RUN,
    deadline: Date.now() + DETAIL_BUDGET_MS,
  };

  for (const [index, artistId] of artistIds.entries()) {
    // Cooldown, hourly cap and claim all happen here rather than at the call site, so the
    // search and save paths pay one cheap invocation instead of a DB round trip per artist.
    if (!(await claimArtistForCatalog(artistId, trigger))) {
      skipped++;
      continue;
    }

    if (index > 0) await sleep(DELAY_BETWEEN_ARTISTS_MS);

    try {
      const found = await catalogArtist(artistId, budget);
      if (found === null) {
        skipped++;
      } else {
        catalogued++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[catalog] artist ${artistId} failed:`, message);
      await recordCatalogOutcome(artistId, { error: message });
    }
  }

  console.log(`[catalog] trigger=${trigger} catalogued=${catalogued} skipped=${skipped}`);
  return { statusCode: 200, body: JSON.stringify({ catalogued, skipped }) };
}

/**
 * Catalog one artist. Returns the release count, or null when there was nothing to do.
 *
 * @throws on a genuine failure, so the caller records it against the backoff counter.
 */
async function catalogArtist(artistId: string, budget: DetailBudget): Promise<number | null> {
  const storedUrl = await getArtistBandcampUrl(artistId);
  if (!storedUrl) {
    await recordCatalogOutcome(artistId, { error: 'no bandcamp link stored' });
    return null;
  }

  // The stored URL is not automatically trustworthy: a claimed artist can save any http(s)
  // URL to their profile links, so a row labelled 'bandcamp' may not be Bandcamp at all.
  // The allowlist answers "is this really Bandcamp"; safeFetch separately answers "is this
  // safe to fetch". Both are needed — they are different questions.
  if (!isUrlHostnameAllowed(storedUrl)) {
    await recordCatalogOutcome(artistId, { error: `stored bandcamp url not allowlisted: ${safeHostname(storedUrl)}` });
    return null;
  }

  const musicUrl = bandcampMusicUrl(storedUrl);
  if (!musicUrl) {
    await recordCatalogOutcome(artistId, { error: 'could not derive /music url' });
    return null;
  }

  const response = await safeFetch(musicUrl, 10_000);
  if (!response) throw new Error('fetch refused or too many redirects');
  if (!response.ok) throw new Error(`bandcamp responded ${response.status}`);

  const landedUrl = response.url || musicUrl;
  const html = await response.text();
  const outcome = ingestBandcampGrid(html, landedUrl);

  if (!outcome.ok) {
    // A bot challenge is the upstream declining to answer, not an artist with no releases.
    // Throwing marks it a failure so it backs off and retries; recording it as a successful
    // zero would poison the cooldown with a false negative for a week.
    if (outcome.reason === 'bot_challenge') throw new Error('bandcamp bot challenge');

    await recordCatalogOutcome(artistId, { releasesFound: 0 });
    return 0;
  }

  const written = await persistReleases(artistId, outcome.releases);
  const detailed = await catalogDetails(written, landedUrl, budget);

  await recordCatalogOutcome(artistId, {
    releasesFound: written.length,
    releasesDetailed: detailed,
  });
  return written.length;
}

/**
 * Read individual release pages for dates, formats and prices.
 *
 * This is where the differentiator's data comes from — *"vinyl $25 · CD $12 · digital $10, ≈$21
 * to the artist"* exists nowhere in the grid — so it can't be skipped, and it can't be
 * unbounded either. It's the one part of ingest whose cost scales with catalog size rather
 * than artist count.
 *
 * Returns how many pages were read successfully. Never throws: a release page failing is not a
 * reason to fail the artist's whole catalog, which is already written by this point.
 */
async function catalogDetails(
  releases: PersistedRelease[],
  landedUrl: string,
  budget: DetailBudget
): Promise<number> {
  const due = releases.filter(needsDetail).slice(0, MAX_DETAIL_FETCHES_PER_ARTIST);
  if (due.length === 0) return 0;

  let landedHost: string;
  try {
    landedHost = new URL(landedUrl).host;
  } catch {
    return 0;
  }

  let read = 0;
  let attempted = 0;

  for (const release of due) {
    if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) {
      // Said out loud rather than returning quietly: a silent cap reads as "we checked
      // everything and there were no prices", which is the wrong conclusion to hand anyone
      // looking at why a release page is bare.
      console.log(`[catalog] detail budget spent — ${due.length - attempted} release(s) left for a later run`);
      break;
    }

    if (!isFetchableReleaseUrl(release.url, landedHost)) {
      console.warn(`[catalog] skipped release url: ${safeHostname(release.url)}`);
      continue;
    }

    // Spacing is per *request*, so a run of failures doesn't turn into a burst.
    if (attempted > 0) await sleep(DELAY_BETWEEN_DETAIL_FETCHES_MS);
    attempted++;
    budget.fetchesLeft--;

    try {
      const detailResponse = await safeFetch(release.url, 10_000);
      if (!detailResponse?.ok) continue;

      const outcome = ingestBandcampDetail(await detailResponse.text());
      if (!outcome.ok) {
        // A challenge means every subsequent request in this run is likely to be challenged
        // too. Stop asking rather than burning the budget being refused, and leave
        // detail_checked_at unset so these releases are retried.
        if (outcome.reason === 'bot_challenge') {
          console.warn('[catalog] bandcamp bot challenge on a release page — stopping detail pass');
          break;
        }
        console.warn(`[catalog] unreadable release page: ${safeHostname(release.url)}`);
        continue;
      }

      if (await persistReleaseDetail(release, outcome.detail)) read++;
    } catch (error) {
      console.warn(
        `[catalog] detail fetch failed for ${safeHostname(release.url)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return read;
}

/**
 * May we fetch this stored release URL?
 *
 * Two ways to qualify, because there are two ways a legitimate release URL arises:
 *
 * - **Same host as the page we just read.** A URL parsed out of this run's grid, which is how
 *   Bandcamp Pro custom domains (`music.sufjan.com`) get in at all — they're nowhere near the
 *   outbound allowlist, and their legitimacy comes from Bandcamp having redirected us there.
 * - **On the allowlist.** A row stored by an earlier run, from before the artist moved to a
 *   custom domain. Without this the host check would refuse those rows forever and their
 *   prices would never be read.
 *
 * Neither answers "is this safe to fetch" — `safeFetch` does that separately, on every
 * redirect hop. Three different questions, deliberately not collapsed into one.
 */
function isFetchableReleaseUrl(url: string, landedHost: string): boolean {
  try {
    if (new URL(url).host === landedHost) return true;
  } catch {
    return false;
  }
  return isUrlHostnameAllowed(url);
}

/** Never read, or read long enough ago that its prices are worth refreshing. */
function needsDetail(release: PersistedRelease): boolean {
  if (!release.detailCheckedAt) return true;
  const age = Date.now() - new Date(release.detailCheckedAt).getTime();
  return age > DETAIL_REFRESH_DAYS * 24 * 3600_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
