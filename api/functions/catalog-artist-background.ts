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
  persistReleases,
  recordCatalogOutcome,
  type CatalogTrigger,
} from './db';
import { isUrlHostnameAllowed } from './middleware';
import { safeFetch, safeHostname } from './safe-fetch';
import { bandcampMusicUrl, ingestBandcampGrid } from './release-ingest';

/** Ceiling on artists per invocation, so one call can't become an unbounded crawl. */
const MAX_ARTISTS_PER_RUN = 25;

/** Pause between artists. One Bandcamp request each, spaced out rather than in a burst. */
const DELAY_BETWEEN_ARTISTS_MS = 1_000;

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

  for (const [index, artistId] of artistIds.entries()) {
    // Cooldown, hourly cap and claim all happen here rather than at the call site, so the
    // search and save paths pay one cheap invocation instead of a DB round trip per artist.
    if (!(await claimArtistForCatalog(artistId, trigger))) {
      skipped++;
      continue;
    }

    if (index > 0) await sleep(DELAY_BETWEEN_ARTISTS_MS);

    try {
      const found = await catalogArtist(artistId);
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
async function catalogArtist(artistId: string): Promise<number | null> {
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

  const html = await response.text();
  const outcome = ingestBandcampGrid(html, response.url || musicUrl);

  if (!outcome.ok) {
    // A bot challenge is the upstream declining to answer, not an artist with no releases.
    // Throwing marks it a failure so it backs off and retries; recording it as a successful
    // zero would poison the cooldown with a false negative for a week.
    if (outcome.reason === 'bot_challenge') throw new Error('bandcamp bot challenge');

    await recordCatalogOutcome(artistId, { releasesFound: 0 });
    return 0;
  }

  const written = await persistReleases(artistId, outcome.releases);
  await recordCatalogOutcome(artistId, { releasesFound: written });
  return written;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
