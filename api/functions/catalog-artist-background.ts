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

import {
  claimArtistForCatalog,
  getArtistForCatalog,
  persistDiscogsReleases,
  persistFaircampReleases,
  persistJamcoopReleases,
  persistMirloReleases,
  persistMusicBrainzEnrichment,
  persistReleaseDetail,
  persistReleases,
  recordCatalogOutcome,
  attachDiscoveredSource,
  type CatalogTrigger,
  type PersistedRelease,
} from './db';
import { isInternalRequest, isUrlHostnameAllowed } from './middleware';
import { safeFetch, safeHostname } from './safe-fetch';
import {
  bandcampMusicUrl,
  buildFaircampRelease,
  buildJamcoopRelease,
  findDiscoveredReleaseLinks,
  ingestBandcampDetail,
  ingestBandcampGrid,
  ingestDiscogsMasters,
  ingestDiscogsReleaseDetail,
  ingestFaircampHomeLinks,
  ingestFaircampPurchasePage,
  ingestFaircampReleasePage,
  ingestJamcoopAlbumPage,
  ingestJamcoopArtistPage,
  ingestMirloArtist,
  ingestMusicBrainzReleaseGroups,
  jamcoopArtistUrl,
  mirloArtistSlug,
  type DiscogsArtistReleaseEntry,
  type DiscogsReleaseDetailRaw,
  type IngestedOffer,
  type MusicBrainzReleaseGroupRaw,
} from './release-ingest';
import { isCatalogEnabled } from './request-catalog';
import { musicBrainzArtistQuery, normalizeForComparison } from './search-utils';
import { extractDiscogsArtistId } from '../search/enrichment';

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

/**
 * Newest-first, so a large discography gets its recent releases priced on the first run.
 *
 * Raised from 20 once an explicit re-catalogue started resetting every source to unpriced
 * (`clearReleaseDetailCooldown`): at 20, an artist with more releases than that could never get
 * their whole catalogue priced, because each press re-read the same newest 20 and left the tail
 * permanently unread. 40 covers every catalogue measured so far — 22 for Kid Lightbulbs, 16 for
 * Sufjan Stevens, 33 for the largest live Mirlo artist — and costs 40 paced seconds for one
 * artist. The invocation-wide cap below still bounds a whole batch.
 */
const MAX_DETAIL_FETCHES_PER_ARTIST = 40;

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

// --- Discogs + MusicBrainz enrichment budgets ---------------------------------
//
// Both ride along after Bandcamp within the same per-artist catalog run, sharing the
// invocation's 15-minute Netlify ceiling with Bandcamp's own 9-minute detail budget above.
// Neither ever fails the artist's run: a MusicBrainz hiccup or a Discogs rate-limit response
// is worth logging, not worth discarding Bandcamp data this run already wrote.

const DISCOGS_USER_AGENT = 'Unstream/1.0 (https://unstream.stream - ethical music finder)';
const MUSICBRAINZ_USER_AGENT = 'Unstream/1.0 (https://unstream.stream - ethical music finder)';

/** Sanity check before an MBID from MusicBrainz's own response is interpolated into a URL. */
const MB_MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Discogs allows 25 req/min unauthenticated; paced well under that with margin to spare. */
const DELAY_BETWEEN_DISCOGS_FETCHES_MS = 2_600;

/** Filtered to `role: Main` + `type: master` per-artist, so this bounds priced releases, not raw listing rows. */
const MAX_DISCOGS_MASTERS_PER_ARTIST = 5;

/** Invocation-wide, list + detail requests combined. */
const MAX_DISCOGS_FETCHES_PER_RUN = 30;

/** How many raw (unfiltered) rows to read from `/artists/{id}/releases` before stopping. */
const MAX_DISCOGS_LIST_PAGES = 2;

interface DiscogsBudget {
  fetchesLeft: number;
  deadline: number;
}

/**
 * Stop *starting* Discogs, MusicBrainz, Faircamp or official-site work for a new artist this
 * long into the invocation — leaving headroom on top of Bandcamp's own 9-minute detail budget
 * so a 25-artist batch ends by finishing rather than being killed mid-write.
 */
const ENRICHMENT_CUTOFF_MS = 13 * 60_000;

// --- Faircamp + discovered-link budgets ---------------------------------------
//
// Unlike Discogs and MusicBrainz, Faircamp has no centralized rate limit to respect — every
// instance is a different self-hosted domain — so the ceiling here is about not fetching an
// unbounded number of pages per artist, not about a shared API's tolerance.

/** One request per candidate release page, spaced out rather than in a burst. */
const DELAY_BETWEEN_FAIRCAMP_FETCHES_MS = 1_000;

/** Bounds cost for an artist with an unusually large Faircamp archive. */
const MAX_FAIRCAMP_RELEASES_PER_ARTIST = 20;

/**
 * Invocation-wide, across every artist in the batch: homepage, release pages and purchase
 * pages combined. A release costs up to two requests, not one, because Faircamp keeps the price
 * on a separate purchase page — hence the headroom over the old ceiling of 100.
 */
const MAX_FAIRCAMP_FETCHES_PER_RUN = 150;

interface FaircampBudget {
  fetchesLeft: number;
  deadline: number;
}

// --- Jam.coop budgets ----------------------------------------------------------
//
// One small co-op's own servers, so the pacing is deliberately gentler than the ~1/sec used
// against Bandcamp. Jam.coop's robots.txt sets no crawl-delay at all — this is courtesy, not
// compliance, and it costs nothing because the catalogues are small (one album is typical;
// the largest seen was a handful).
//
// Cheaper per release than any other source: title, artwork, date, price, currency and format
// all arrive in the single album-page fetch, so a release costs one request rather than
// Faircamp's two or Bandcamp's grid-plus-detail.

const DELAY_BETWEEN_JAMCOOP_FETCHES_MS = 1_500;

/** Bounds one artist with an unusually large Jam.coop catalogue. */
const MAX_JAMCOOP_RELEASES_PER_ARTIST = 20;

/** Invocation-wide, artist pages and album pages combined. */
const MAX_JAMCOOP_FETCHES_PER_RUN = 60;

interface JamcoopBudget {
  fetchesLeft: number;
  deadline: number;
}

// --- Mirlo budgets -------------------------------------------------------------
//
// The cheapest source in the codebase: `/v1/artists/{slug}` returns the whole discography **and
// its prices** in one request, so an artist costs exactly one fetch and there is no detail pass.
// Compare Bandcamp (grid + one page per release) and Jam.coop (artist page + one per album).
//
// Mirlo granted Unstream permission to use this endpoint and issued an API key (2026-08-05), so
// the `Disallow: /v1/` in their robots.txt is superseded by direct consent rather than ignored.
// The pacing below is still deliberately gentle: a small co-op's own servers, and the recatalog
// sweep runs four times a day.

const DELAY_BETWEEN_MIRLO_FETCHES_MS = 1_000;

/**
 * Invocation-wide. One request per artist, so this is effectively "how many Mirlo artists can one
 * batch cover" — set to the batch ceiling (`MAX_ARTISTS_PER_RUN`) since no artist needs a second.
 */
const MAX_MIRLO_FETCHES_PER_RUN = 25;

interface MirloBudget {
  fetchesLeft: number;
  deadline: number;
}

/**
 * Sent as `mirlo-api-key` when set.
 *
 * Verified live 2026-08-05: this endpoint returns byte-identical responses with the key, with a
 * bearer token, and with no auth at all — so the key is **not** what grants access, and an absent
 * key must not disable the pass. It is sent because Mirlo issued it for this use and it lets them
 * attribute our traffic; if they later gate or rate-limit by key, we are already correct.
 */
const MIRLO_API_KEY = process.env.MIRLO_API_KEY;

const MIRLO_USER_AGENT = 'Unstream/1.0 (https://unstream.stream - ethical music finder)';

export async function handler(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: '' };
  }

  // The blast radius of the shared internal secret is small here: cooldown and hourly caps are
  // enforced below regardless of who calls, and only artists already in our database can be named.
  if (!isInternalRequest(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: '' };
  }

  // Checked here as well as at the caller. The caller-side gate stops a preview from asking;
  // this one means the guarantee holds no matter who asks, since this function is what actually
  // writes to the production database.
  if (!isCatalogEnabled()) {
    console.log('[catalog] refusing — RELEASE_CATALOG_ENABLED is not set on this deploy');
    return { statusCode: 403, body: JSON.stringify({ skipped: 'cataloging disabled on this deploy' }) };
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
  // Allowlisted, not cast: an unrecognized trigger falls back to the smallest budget rather
  // than reaching CATALOG_HOURLY_CAP as an undefined key, where the cap comparison would pass.
  const trigger: CatalogTrigger =
    body.trigger === 'saved' || body.trigger === 'scheduled' ? body.trigger : 'searched';

  if (artistIds.length === 0) return { statusCode: 400, body: '' };

  let catalogued = 0;
  let skipped = 0;
  const budget: DetailBudget = {
    fetchesLeft: MAX_DETAIL_FETCHES_PER_RUN,
    deadline: Date.now() + DETAIL_BUDGET_MS,
  };
  const discogsBudget: DiscogsBudget = {
    fetchesLeft: MAX_DISCOGS_FETCHES_PER_RUN,
    deadline: Date.now() + ENRICHMENT_CUTOFF_MS,
  };
  const faircampBudget: FaircampBudget = {
    fetchesLeft: MAX_FAIRCAMP_FETCHES_PER_RUN,
    deadline: Date.now() + ENRICHMENT_CUTOFF_MS,
  };
  const jamcoopBudget: JamcoopBudget = {
    fetchesLeft: MAX_JAMCOOP_FETCHES_PER_RUN,
    deadline: Date.now() + ENRICHMENT_CUTOFF_MS,
  };
  const mirloBudget: MirloBudget = {
    fetchesLeft: MAX_MIRLO_FETCHES_PER_RUN,
    deadline: Date.now() + ENRICHMENT_CUTOFF_MS,
  };
  const enrichmentDeadline = Date.now() + ENRICHMENT_CUTOFF_MS;

  for (const [index, artistId] of artistIds.entries()) {
    // Cooldown, hourly cap and claim all happen here rather than at the call site, so the
    // search and save paths pay one cheap invocation instead of a DB round trip per artist.
    if (!(await claimArtistForCatalog(artistId, trigger))) {
      skipped++;
      continue;
    }

    if (index > 0) await sleep(DELAY_BETWEEN_ARTISTS_MS);

    try {
      const found = await catalogArtist(
        artistId,
        budget,
        discogsBudget,
        faircampBudget,
        jamcoopBudget,
        mirloBudget,
        enrichmentDeadline
      );
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
 * Catalog one artist across every source we have a link for. Returns the total release count,
 * or null when there was nothing to do at all.
 *
 * Bandcamp remains the one source whose own failures can still surface as a thrown error (see
 * `catalogBandcamp`), but that error is caught here rather than left to unwind the whole
 * function — a Bandcamp bot challenge has nothing to do with whether the other sources can
 * answer this run. Only when *nothing* came of the run — Bandcamp failed and nothing else
 * added anything — does the run count as a failure against the backoff counter.
 */
async function catalogArtist(
  artistId: string,
  budget: DetailBudget,
  discogsBudget: DiscogsBudget,
  faircampBudget: FaircampBudget,
  jamcoopBudget: JamcoopBudget,
  mirloBudget: MirloBudget,
  enrichmentDeadline: number
): Promise<number | null> {
  const artist = await getArtistForCatalog(artistId);
  if (!artist) {
    await recordCatalogOutcome(artistId, { error: 'artist not found' });
    return null;
  }
  // Keep this list identical to CATALOGUEABLE_PLATFORMS in db.ts — the sweep picks its pool from
  // that constant, and an artist it sweeps but this rejects is recorded as a failure.
  if (
    !artist.bandcampUrl &&
    !artist.discogsUrl &&
    !artist.faircampUrl &&
    !artist.jamcoopUrl &&
    !artist.mirloUrl
  ) {
    await recordCatalogOutcome(artistId, {
      error: 'no bandcamp, discogs, faircamp, jam.coop, or mirlo link stored',
    });
    return null;
  }

  let totalFound = 0;
  let totalDetailed = 0;
  let bandcampError: string | null = null;

  if (artist.bandcampUrl) {
    try {
      const { found, detailed } = await catalogBandcamp(artistId, artist.bandcampUrl, budget);
      totalFound += found;
      totalDetailed += detailed;
    } catch (error) {
      bandcampError = error instanceof Error ? error.message : String(error);
      console.error(`[catalog] bandcamp pass failed for artist ${artistId}:`, bandcampError);
    }
  }

  // Stop *starting* new enrichment work once the invocation is close to Netlify's ceiling —
  // an artist skipped here simply gets picked up by the artist's normal 7-day recatalog
  // cooldown next time, rather than the whole batch being killed mid-write.
  if (Date.now() < enrichmentDeadline) {
    if (artist.discogsUrl) {
      totalFound += await catalogDiscogs(artistId, artist.discogsUrl, discogsBudget);
    }
    await catalogMusicBrainz(artistId, artist.name);
    if (artist.faircampUrl) {
      totalFound += await catalogFaircamp(artistId, artist.faircampUrl, faircampBudget);
    }
    if (artist.jamcoopUrl) {
      const { found, detailed } = await catalogJamcoop(artistId, artist.jamcoopUrl, jamcoopBudget);
      totalFound += found;
      totalDetailed += detailed;
    }
    if (artist.mirloUrl) {
      // Not counted in totalDetailed: Mirlo has no detail pass to run, so every release it
      // writes arrives complete. Counting them as "detailed" would inflate a figure whose whole
      // meaning is "how many second fetches did we spend".
      totalFound += await catalogMirlo(artistId, artist.mirloUrl, mirloBudget);
    }
    if (artist.officialSiteUrl) {
      await catalogOfficialSite(artistId, artist.officialSiteUrl);
    }
  }

  if (bandcampError && totalFound === 0) {
    await recordCatalogOutcome(artistId, { error: bandcampError });
    return null;
  }

  await recordCatalogOutcome(artistId, {
    releasesFound: totalFound,
    releasesDetailed: totalDetailed,
  });
  return totalFound;
}

/**
 * The Bandcamp pass: grid, then a budgeted detail pass over individual release pages.
 *
 * @throws on a genuine failure — a bot challenge or an unreachable fetch — so the caller can
 * tell "Bandcamp declined to answer" apart from "Bandcamp said zero releases".
 */
async function catalogBandcamp(
  artistId: string,
  storedUrl: string,
  budget: DetailBudget
): Promise<{ found: number; detailed: number }> {
  // The stored URL is not automatically trustworthy: a claimed artist can save any http(s)
  // URL to their profile links, so a row labelled 'bandcamp' may not be Bandcamp at all.
  // The allowlist answers "is this really Bandcamp"; safeFetch separately answers "is this
  // safe to fetch". Both are needed — they are different questions.
  if (!isUrlHostnameAllowed(storedUrl)) {
    console.warn(`[catalog] stored bandcamp url not allowlisted: ${safeHostname(storedUrl)}`);
    return { found: 0, detailed: 0 };
  }

  const musicUrl = bandcampMusicUrl(storedUrl);
  if (!musicUrl) {
    console.warn(`[catalog] could not derive /music url for artist ${artistId}`);
    return { found: 0, detailed: 0 };
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
    return { found: 0, detailed: 0 };
  }

  const written = await persistReleases(artistId, outcome.releases);
  const detailed = await catalogDetails(written, landedUrl, budget);
  return { found: written.length, detailed };
}

/**
 * The Discogs pass: a cheap paginated listing (filtered to `role: Main` + `type: master`),
 * then a budgeted detail pass over the newest masters for price and format data.
 *
 * Never throws — a Discogs hiccup is worth logging, not worth failing an artist whose
 * Bandcamp pass may have already succeeded this run.
 */
async function catalogDiscogs(artistId: string, discogsUrl: string, budget: DiscogsBudget): Promise<number> {
  const discogsArtistId = extractDiscogsArtistId(discogsUrl);
  if (!discogsArtistId) return 0;

  try {
    const entries: DiscogsArtistReleaseEntry[] = [];

    for (let page = 1; page <= MAX_DISCOGS_LIST_PAGES; page++) {
      if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) break;
      if (page > 1) await sleep(DELAY_BETWEEN_DISCOGS_FETCHES_MS);
      budget.fetchesLeft--;

      const listUrl = `https://api.discogs.com/artists/${discogsArtistId}/releases?per_page=100&page=${page}&sort=year&sort_order=desc`;
      const response = await globalThis.fetch(listUrl, { headers: { 'User-Agent': DISCOGS_USER_AGENT } });
      if (!response.ok) {
        console.warn(`[catalog] discogs artist-releases responded ${response.status} for artist ${artistId}`);
        break;
      }

      const data = (await response.json()) as {
        releases?: DiscogsArtistReleaseEntry[];
        pagination?: { pages?: number };
      };
      entries.push(...(data.releases ?? []));
      if (page >= (data.pagination?.pages ?? 1)) break;
    }

    const masters = ingestDiscogsMasters(entries).slice(0, MAX_DISCOGS_MASTERS_PER_ARTIST);
    if (masters.length === 0) return 0;

    const written = await persistDiscogsReleases(
      artistId,
      masters.map(m => ({
        title: m.title,
        slug: m.slug,
        matchKey: m.matchKey,
        releaseType: m.releaseType,
        releaseDate: m.releaseDate,
        datePrecision: m.datePrecision,
        status: m.status,
        masterId: m.masterId,
        mainReleaseId: m.mainReleaseId,
      }))
    );

    for (const release of written) {
      // Only price a master once; re-pricing rides the same cooldown as the rest of this
      // artist's catalog rather than its own schedule.
      if (release.detailCheckedAt) continue;

      if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) {
        console.log(`[catalog] discogs detail budget spent for artist ${artistId}`);
        break;
      }
      await sleep(DELAY_BETWEEN_DISCOGS_FETCHES_MS);
      budget.fetchesLeft--;

      try {
        const releaseId = release.url.split('/').pop();
        const detailResponse = await globalThis.fetch(`https://api.discogs.com/releases/${releaseId}`, {
          headers: { 'User-Agent': DISCOGS_USER_AGENT },
        });
        if (!detailResponse.ok) continue;

        const detail = ingestDiscogsReleaseDetail((await detailResponse.json()) as DiscogsReleaseDetailRaw);
        await persistReleaseDetail(release, detail);
      } catch (error) {
        console.warn(
          '[catalog] discogs detail fetch failed:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return written.length;
  } catch (error) {
    console.warn('[catalog] discogs ingest failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/**
 * The MusicBrainz pass: enrichment only. Finds this artist's release groups and merges in
 * whatever they add to releases we already have — never creates a new one, since MusicBrainz
 * has no purchase link to offer (see `persistMusicBrainzEnrichment`).
 *
 * Two requests, spaced by MusicBrainz's mandatory ~1/sec rate limit — the same pacing
 * `search-musicbrainz.ts` already uses against the same API. Never throws.
 */
async function catalogMusicBrainz(artistId: string, artistName: string): Promise<void> {
  try {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(musicBrainzArtistQuery(artistName))}&fmt=json&limit=1`;
    const searchResponse = await globalThis.fetch(searchUrl, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!searchResponse.ok) return;

    const searchData = (await searchResponse.json()) as { artists?: { id: string; name: string; score: number }[] };
    const artist = searchData.artists?.[0];
    if (!artist || artist.score < 95 || !MB_MBID_PATTERN.test(artist.id)) return;

    // Same over-eager-match guard as search-musicbrainz.ts: a low-confidence name match would
    // attach some other artist's release dates and MBIDs to this one's catalog.
    const queryNormalized = normalizeForComparison(artistName);
    const artistNormalized = normalizeForComparison(artist.name);
    const isNameMatch =
      queryNormalized === artistNormalized ||
      (queryNormalized.includes(artistNormalized) && artistNormalized.length > queryNormalized.length * 0.7) ||
      (artistNormalized.includes(queryNormalized) && queryNormalized.length > artistNormalized.length * 0.7);
    if (!isNameMatch) return;

    await sleep(1_100); // MusicBrainz's mandatory ~1 req/sec

    const rgUrl = `https://musicbrainz.org/ws/2/release-group?artist=${artist.id}&fmt=json&limit=100`;
    const rgResponse = await globalThis.fetch(rgUrl, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!rgResponse.ok) return;

    const rgData = (await rgResponse.json()) as { 'release-groups'?: MusicBrainzReleaseGroupRaw[] };
    const groups = ingestMusicBrainzReleaseGroups(rgData['release-groups'] ?? []);
    if (groups.length === 0) return;

    const touched = await persistMusicBrainzEnrichment(artistId, groups);
    if (touched > 0) console.log(`[catalog] musicbrainz enriched ${touched} release(s) for artist ${artistId}`);
  } catch (error) {
    console.warn('[catalog] musicbrainz enrichment failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The Faircamp pass: fetch the artist's homepage, discover candidate release links, then fetch
 * each one (budgeted) for title and artwork via `ingestFaircampReleasePage`. Every page fetched
 * along the way is also scanned for discovered links to platforms we can't fetch directly
 * (Subvert today) — an artist's Faircamp page is exactly the kind of place a "buy this
 * elsewhere" link shows up.
 *
 * Never throws — an unreachable or oddly-themed Faircamp instance is worth logging, not worth
 * failing an artist whose Bandcamp pass may have already succeeded this run.
 */
async function catalogFaircamp(artistId: string, faircampUrl: string, budget: FaircampBudget): Promise<number> {
  try {
    if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) return 0;
    budget.fetchesLeft--;

    const homeResponse = await safeFetch(faircampUrl, 10_000);
    if (!homeResponse?.ok) return 0;

    const landedUrl = homeResponse.url || faircampUrl;
    const homeHtml = await homeResponse.text();
    await scanForDiscoveredLinks(artistId, homeHtml, landedUrl);

    const candidates = ingestFaircampHomeLinks(homeHtml, landedUrl).slice(0, MAX_FAIRCAMP_RELEASES_PER_ARTIST);
    if (candidates.length === 0) return 0;

    const takenSlugs = new Set<string>();
    const toPersist: Parameters<typeof persistFaircampReleases>[1] = [];
    // Where each release's price lives, keyed by the release URL that becomes its source URL.
    // Read now, fetched after the write, so the 30-day refresh rule can be applied to a source
    // whose `detail_checked_at` only exists once it has been persisted.
    const purchaseUrls = new Map<string, string>();

    for (const candidate of candidates) {
      if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) {
        console.log(`[catalog] faircamp budget spent for artist ${artistId}`);
        break;
      }
      if (toPersist.length > 0) await sleep(DELAY_BETWEEN_FAIRCAMP_FETCHES_MS);
      budget.fetchesLeft--;

      try {
        const response = await safeFetch(candidate.url, 10_000);
        if (!response?.ok) continue;

        const html = await response.text();
        const page = ingestFaircampReleasePage(html);
        if (page) {
          const release = buildFaircampRelease(page, candidate.url, takenSlugs);
          if (release) {
            takenSlugs.add(release.slug);
            toPersist.push(release);
            if (page.purchaseHref) {
              const purchaseUrl = resolveSameHost(page.purchaseHref, response.url || candidate.url);
              if (purchaseUrl) purchaseUrls.set(release.externalUrl, purchaseUrl);
            }
          }
        }

        await scanForDiscoveredLinks(artistId, html, response.url || candidate.url);
      } catch (error) {
        console.warn(
          `[catalog] faircamp release fetch failed for ${safeHostname(candidate.url)}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (toPersist.length === 0) return 0;

    const written = await persistFaircampReleases(artistId, toPersist);
    await catalogFaircampPrices(written, purchaseUrls, budget);
    return written.length;
  } catch (error) {
    console.warn('[catalog] faircamp ingest failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/**
 * Read Faircamp prices, one purchase page per release that's due one.
 *
 * Separate from the release-page pass above because it can only run after the write: whether a
 * release is due a refresh is a fact about its stored source (`detail_checked_at`), and that
 * doesn't exist until `persistFaircampReleases` has created it. Same 30-day rule as Bandcamp's
 * detail pass, so a re-catalog of an unchanged Faircamp site costs nothing extra.
 *
 * Never throws — a purchase page that won't load leaves the release with no price, which is what
 * it already had.
 */
async function catalogFaircampPrices(
  written: PersistedRelease[],
  purchaseUrls: Map<string, string>,
  budget: FaircampBudget
): Promise<void> {
  for (const release of written) {
    const purchaseUrl = purchaseUrls.get(release.url);
    if (!purchaseUrl || !needsDetail(release)) continue;

    if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) {
      console.log('[catalog] faircamp budget spent before prices were read');
      return;
    }
    await sleep(DELAY_BETWEEN_FAIRCAMP_FETCHES_MS);
    budget.fetchesLeft--;

    try {
      const response = await safeFetch(purchaseUrl, 10_000);
      if (!response?.ok) continue;

      const offer = ingestFaircampPurchasePage(await response.text());
      if (!offer) {
        console.warn(`[catalog] no readable price on ${safeHostname(purchaseUrl)} purchase page`);
        continue;
      }

      // status null: Faircamp knows nothing about the release's date, so it must not restate
      // the row's status — only the offer is written. See `DetailToPersist`.
      await persistReleaseDetail(release, {
        releaseDate: null,
        datePrecision: 'unknown',
        status: null,
        offers: [offer],
      });
    } catch (error) {
      console.warn(
        `[catalog] faircamp purchase fetch failed for ${safeHostname(purchaseUrl)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/**
 * The Jam.coop pass: fetch the artist page for its album list, then one page per album for
 * everything else.
 *
 * Unlike Faircamp there is no second "prices live somewhere else" round trip — Jam.coop's album
 * page carries the date and the price alongside the title and artwork, so one fetch produces a
 * complete release.
 *
 * That single fetch is also why this pass has no 30-day `detail_checked_at` skip like Bandcamp's
 * and Faircamp's detail passes do: the album page *is* how a release is identified at all, so
 * there is nothing to skip to. Every run re-reads every album page. That's affordable here and
 * nowhere else — Jam.coop catalogues are tiny (one album is typical across the platform's 231
 * artists), the per-artist cooldown is 7 days, and the per-artist ceiling is 20 — so the worst
 * case for one artist is 21 requests a week, against Bandcamp's grid-plus-40.
 *
 * Returns found/detailed separately so `releases_detailed` stays meaningful — the two fail
 * independently here just as they do for Bandcamp (an artist page can parse perfectly while
 * every album page is unreachable).
 *
 * Never throws: a Jam.coop hiccup is worth logging, not worth failing an artist whose Bandcamp
 * pass may have already succeeded this run.
 */
async function catalogJamcoop(
  artistId: string,
  storedUrl: string,
  budget: JamcoopBudget
): Promise<{ found: number; detailed: number }> {
  try {
    // Two different questions, same as the Bandcamp pass: the allowlist answers "is this really
    // Jam.coop" (a claimed artist can store any URL against the platform), safeFetch answers
    // "is this safe to fetch".
    if (!isUrlHostnameAllowed(storedUrl)) {
      console.warn(`[catalog] stored jam.coop url not allowlisted: ${safeHostname(storedUrl)}`);
      return { found: 0, detailed: 0 };
    }

    const artistUrl = jamcoopArtistUrl(storedUrl);
    if (!artistUrl) {
      console.warn(`[catalog] could not derive jam.coop artist url for artist ${artistId}`);
      return { found: 0, detailed: 0 };
    }

    if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) return { found: 0, detailed: 0 };
    budget.fetchesLeft--;

    const response = await safeFetch(artistUrl, 10_000);
    if (!response?.ok) return { found: 0, detailed: 0 };

    const landedUrl = response.url || artistUrl;
    const candidates = ingestJamcoopArtistPage(await response.text(), landedUrl).slice(
      0,
      MAX_JAMCOOP_RELEASES_PER_ARTIST
    );
    if (candidates.length === 0) return { found: 0, detailed: 0 };

    const takenSlugs = new Set<string>();
    const toPersist: Parameters<typeof persistJamcoopReleases>[1] = [];
    // Offers are read now but written after the release rows exist, since an offer hangs off a
    // `release_sources.id` that only comes into being at persist time.
    const offersByUrl = new Map<string, IngestedOffer[]>();

    for (const candidate of candidates) {
      if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) {
        console.log(`[catalog] jam.coop budget spent for artist ${artistId}`);
        break;
      }
      if (toPersist.length > 0) await sleep(DELAY_BETWEEN_JAMCOOP_FETCHES_MS);
      budget.fetchesLeft--;

      try {
        const albumResponse = await safeFetch(candidate.url, 10_000);
        if (!albumResponse?.ok) continue;

        const page = ingestJamcoopAlbumPage(await albumResponse.text());
        if (!page) {
          console.warn(`[catalog] unreadable jam.coop album page: ${candidate.url}`);
          continue;
        }

        const release = buildJamcoopRelease(page, candidate, takenSlugs);
        if (!release) continue;

        takenSlugs.add(release.slug);
        toPersist.push(release);
        if (release.offers.length > 0) offersByUrl.set(release.externalUrl, release.offers);
      } catch (error) {
        console.warn(
          `[catalog] jam.coop album fetch failed for ${safeHostname(candidate.url)}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (toPersist.length === 0) return { found: 0, detailed: 0 };

    const written = await persistJamcoopReleases(artistId, toPersist);

    let detailed = 0;
    for (const release of written) {
      const offers = offersByUrl.get(release.url);
      if (!offers) continue;

      // status null: the release row's date and status were already written by
      // persistJamcoopReleases from this same page, so restating them here would be a second
      // write of the same fact — and would overwrite a date another source got more precisely.
      const ok = await persistReleaseDetail(release, {
        releaseDate: null,
        datePrecision: 'unknown',
        status: null,
        offers,
      });
      if (ok) detailed++;
    }

    return { found: written.length, detailed };
  } catch (error) {
    console.warn('[catalog] jam.coop ingest failed:', error instanceof Error ? error.message : String(error));
    return { found: 0, detailed: 0 };
  }
}

/**
 * The Mirlo pass: one request, the whole discography, prices included.
 *
 * There is no detail pass and no per-release loop, because there is nothing left to fetch — the
 * offers written below came out of the same response as the release rows.
 *
 * Fetched with `globalThis.fetch` rather than `safeFetch`, matching the Discogs and MusicBrainz
 * passes and for the same reason: the URL is **ours**, built against a hardcoded
 * `api.mirlo.space` host. The only external input is a single path segment derived by
 * `mirloArtistSlug()` (which itself refuses any URL that isn't on mirlo.space) and URL-encoded
 * here. `safeFetch` exists to vet attacker-influenced *hosts*, and there isn't one; it also
 * cannot send the API key, since it hardcodes its headers.
 *
 * A non-200, an unparseable body, or a document for the wrong artist all yield 0 rather than a
 * thrown error — one source declining to answer is not the artist's whole run failing. But they
 * are logged distinctly from "this artist has no releases", which is the case `ingestMirloArtist`
 * returning `null` versus `[]` exists to keep apart.
 */
async function catalogMirlo(
  artistId: string,
  storedUrl: string,
  budget: MirloBudget
): Promise<number> {
  try {
    const slug = mirloArtistSlug(storedUrl);
    if (!slug) {
      console.warn(`[catalog] could not derive mirlo slug for artist ${artistId}`);
      return 0;
    }

    if (budget.fetchesLeft <= 0 || Date.now() > budget.deadline) return 0;
    budget.fetchesLeft--;

    const apiUrl = `https://api.mirlo.space/v1/artists/${encodeURIComponent(slug)}`;
    const headers: Record<string, string> = { 'User-Agent': MIRLO_USER_AGENT };
    if (MIRLO_API_KEY) headers['mirlo-api-key'] = MIRLO_API_KEY;

    const response = await globalThis.fetch(apiUrl, { headers });
    if (!response.ok) {
      console.warn(`[catalog] mirlo responded ${response.status} for artist ${artistId}`);
      return 0;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A 200 whose body isn't JSON is the upstream not answering — a challenge page, an HTML
      // error. Reported rather than swallowed, because it is indistinguishable from success by
      // status code alone.
      console.error(`[catalog] mirlo returned a 200 with a non-JSON body for artist ${artistId}`);
      return 0;
    }

    const releases = ingestMirloArtist(body, slug);
    if (releases === null) {
      console.error(`[catalog] mirlo 200 was not an artist document for ${slug} (artist ${artistId})`);
      return 0;
    }
    if (releases.length === 0) return 0;

    const written = await persistMirloReleases(artistId, releases);

    // Offers hang off a `release_sources.id` that only exists after the rows are written, so the
    // prices from the one response are attached here rather than in the same call.
    const offersByUrl = new Map(
      releases.filter(r => r.offers.length > 0).map(r => [r.externalUrl, r.offers])
    );
    for (const release of written) {
      const offers = offersByUrl.get(release.url);
      if (!offers) continue;

      // status null: the date and status were already written by persistMirloReleases from this
      // same response, so restating them would be a second write of the same fact — and could
      // overwrite a date another source got more precisely.
      await persistReleaseDetail(release, {
        releaseDate: null,
        datePrecision: 'unknown',
        status: null,
        offers,
      });
    }

    await sleep(DELAY_BETWEEN_MIRLO_FETCHES_MS);
    return written.length;
  } catch (error) {
    console.warn('[catalog] mirlo ingest failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/**
 * Resolve a relative href from fetched markup, refusing anything that leaves the host it came
 * from. Same rule, and same reason, as `resolveReleaseUrl` in release-ingest: an href out of
 * fetched markup is untrusted.
 */
function resolveSameHost(href: string, pageUrl: string): string | null {
  try {
    const resolved = new URL(href, pageUrl);
    if (resolved.host !== new URL(pageUrl).host) return null;
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Scan already-fetched HTML for discovered links (Subvert today — see
 * `findDiscoveredReleaseLinks`) and attach any confident, exact-title match. Never throws, and
 * never fetches anything itself — the whole point is surfacing links from pages fetched for a
 * different reason.
 */
async function scanForDiscoveredLinks(artistId: string, html: string, pageUrl: string): Promise<void> {
  try {
    for (const link of findDiscoveredReleaseLinks(html, pageUrl)) {
      const attached = await attachDiscoveredSource(artistId, link.platform, link.url, link.matchKey);
      if (attached) console.log(`[catalog] discovered ${link.platform} link attached for artist ${artistId}`);
    }
  } catch (error) {
    console.warn('[catalog] discovered-link scan failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The official-site pass: one fetch, scanned only for discovered links. An arbitrary personal
 * website has no structure reliable enough to parse a whole release from directly — unlike
 * Faircamp, this never creates a release on its own, only adds a source to one that already
 * exists.
 */
async function catalogOfficialSite(artistId: string, officialSiteUrl: string): Promise<void> {
  try {
    const response = await safeFetch(officialSiteUrl, 10_000);
    if (!response?.ok) return;
    const html = await response.text();
    await scanForDiscoveredLinks(artistId, html, response.url || officialSiteUrl);
  } catch (error) {
    console.warn('[catalog] official-site scan failed:', error instanceof Error ? error.message : String(error));
  }
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
