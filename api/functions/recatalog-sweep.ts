// The scheduled re-catalogue sweep: keep saved artists' catalogues from going stale.
//
// ## Why this exists
//
// Every other catalog trigger is demand-driven — a fan saves an artist, someone searches them,
// an artist or admin presses a button. That leaves a hole the release-alerts feature falls
// straight into. A fan saves an artist, the catalogue is built once, and the weekly alert check
// reads that same catalogue forever: `check-releases` reads the catalogue and returns, and only
// falls back to a live scrape for an artist the catalogue has *never* seen. So if nobody ever
// searches that artist again, their new releases are never discovered and the alerts quietly
// stop. Popular artists stay fresh incidentally because people search them; the long tail of
// saved-but-not-searched artists is exactly who this feature was for.
//
// This sweep is the missing half. Invoked by .github/workflows/recatalog-sweep.yml — there are
// no scheduled Netlify functions in this repo, and a GitHub Actions cron is the precedent.
//
// ## Why it is safe to run repeatedly
//
// It requests; it does not crawl. All the gating stays where it already is: the 7-day cooldown
// and the hourly ceiling in `claimArtistForCatalog`, and the claim itself, which stamps
// `last_attempted_at` before any work starts. A second invocation five minutes after the first
// therefore finds the same artists claimed and does nothing. There is deliberately no second
// rate limiter here.
//
// ## Why it returns a real summary rather than 202
//
// A `-background` function would answer 202 whatever happened, and a scheduled job that reports
// success unconditionally is the same silent failure this fixes. Selection is two cheap reads,
// so this is an ordinary function: it says how many artists it asked for and how stale the
// stalest one was, the workflow prints that, and a non-2xx fails the workflow out loud.

import { getStaleSavedArtistCatalogs } from './db';
import { isInternalRequest } from './middleware';
import { isCatalogEnabled, requestArtistCatalog } from './request-catalog';
import { Sentry } from '../lib/sentry';

/**
 * How many artists one sweep asks for.
 *
 * 25 matches MAX_ARTISTS_PER_RUN in catalog-artist-background, so a sweep is exactly one
 * background invocation. Combined with the daily cadence that refreshes up to 175 artists a
 * week, comfortably more than the saved population, so every saved artist comes round well
 * within their 7-day cooldown. If the saved population ever outgrows that, the stalest-first
 * ordering degrades gracefully — everyone still gets refreshed, just less often — and the
 * lever is the cron cadence, not this number, which is bounded by what one invocation can do.
 */
const SWEEP_BATCH_SIZE = 25;

export async function handler(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!isInternalRequest(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Reported, not logged. On a deploy where cataloging is off this sweep can never do anything,
  // and a scheduled job whose whole output is "200, nothing to do" is indistinguishable from one
  // that is working — which is how release cataloging stayed broken for days before a refusal
  // was said out loud. 503 fails the workflow.
  if (!isCatalogEnabled()) {
    Sentry.captureMessage('[recatalog-sweep] refused — cataloging is disabled on this deploy', {
      level: 'warning',
      tags: { area: 'release-catalog', kind: 'sweep-disabled' },
    });
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Cataloging is disabled on this deploy (RELEASE_CATALOG_ENABLED is not set).' }),
    };
  }

  const selection = await getStaleSavedArtistCatalogs(SWEEP_BATCH_SIZE);

  if (!selection.ok) {
    Sentry.captureMessage('[recatalog-sweep] could not select artists', {
      level: 'error',
      tags: { area: 'release-catalog', kind: 'sweep-selection-failed' },
      extra: { reason: selection.reason },
    });
    return { statusCode: 503, body: JSON.stringify({ error: selection.reason }) };
  }

  const { candidates, savedArtists, inCooldown } = selection;

  // Every saved artist catalogued inside the last 7 days is a good, quiet outcome, not a
  // failure — so this is a 200. The counts are what tell the two apart in the workflow log:
  // savedArtists dropping to 0, or inCooldown never falling, is the shape of a broken sweep.
  const summary = {
    requested: candidates.length,
    savedArtists,
    inCooldown,
    /** How stale the stalest artist was. Null means one had never been attempted at all. */
    stalestAttemptedAt: candidates[0]?.lastAttemptedAt ?? null,
    neverAttempted: candidates.filter(c => c.lastAttemptedAt === null).length,
  };

  if (candidates.length === 0) {
    console.log('[recatalog-sweep] nothing to do:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  }

  // Awaited: the 202 handshake only, but an un-awaited fetch is killed when the Lambda freezes
  // after the response, so a floating promise here would mean the sweep sometimes never leaves.
  const dispatched = await requestArtistCatalog(candidates.map(c => c.artistId), 'scheduled');

  if (!dispatched) {
    // A completed handshake doesn't prove the crawl ran — the dispatcher answers 202 to
    // anything — but a *failed* one proves it didn't, and that is worth failing the workflow on.
    Sentry.captureMessage('[recatalog-sweep] could not reach the cataloging function', {
      level: 'error',
      tags: { area: 'release-catalog', kind: 'sweep-dispatch-failed' },
      extra: summary,
    });
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach the cataloging function', ...summary }) };
  }

  console.log('[recatalog-sweep]', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
}
