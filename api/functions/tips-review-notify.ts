// Scheduled job: push to the admin's phone when an artist newly lands in the admin tip review list
// (docs/specs/artist-patronage-spec.md §6 gate 3).
//
// "The review list" = rows in artist_tip_accounts (this Stripe mode) whose tips_approved_at is
// null — the exact set /api/admin/tips GET shows. An artist finishes Stripe Connect onboarding,
// their account row appears unapproved, and the admin (Brandon) should look at it before fans can
// pay them. This job watches for rows that weren't there last run and pushes a notification.
//
// Invoked by .github/workflows/tips-review-notify.yml (GitHub Actions cron, same precedent as
// recatalog-sweep.yml — there are no scheduled Netlify functions in this repo), guarded by
// isInternalRequest so only the workflow can fire it.
//
// New-ness is decided against a watermark stored in Upstash: the set of unapproved
// stripe_account_ids seen by the previous run (cache key tiprevwm:{livemode}). A row in Supabase
// but not in the watermark = new → alert. The watermark TTL (7 days) only matters if the job
// stops running; every successful run refreshes it, so normal operation is stateless drift-free.
// Fail-closed on both sides: if Supabase is unreachable the run fails loudly (CI marks it), and
// if Upstash is unreachable every unapproved row would look new — so instead the run refuses to
// alert and reports an error rather than risk alert-spam.

import { getClient } from './db';
import { isInternalRequest } from './middleware';
import { isLiveMode } from './stripe';
import { cacheGet, cacheSet } from './cache';
import { getRedis } from './redis';
import { withSentry, Sentry } from '../lib/sentry';
import { sendAdminPush } from './admin-push';

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}

/** The account ids awaiting approval on the previous successful run. */
const WATERMARK_TTL_SECONDS = 7 * 24 * 60 * 60;

function watermarkKey(): string {
  return `tiprevwm:${isLiveMode() ? 'live' : 'test'}`;
}

interface ReviewRow {
  stripe_account_id: string;
  created_at: string;
  country: string | null;
  artists: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

function pushReviewAlert(artistName: string, slug: string, createdAt: string): Promise<boolean> {
  return sendAdminPush({
    title: `New tip review: ${artistName}`,
    message: `${artistName} just finished Stripe Connect onboarding and is awaiting tip review. Connected ${createdAt.slice(0, 10)}. Artist page: https://unstream.stream/a/${slug}`,
    // Opens the admin tips review page (auth still applies there).
    url: 'https://unstream.stream/admin/tips',
  });
}

async function handleRequest(event: HandlerEvent) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (!isInternalRequest(event.headers.authorization || event.headers.Authorization || undefined)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const client = getClient();
  if (!client) return { statusCode: 500, body: JSON.stringify({ error: 'Database not configured' }) };

  const { data, error } = await client
    .from('artist_tip_accounts')
    .select('stripe_account_id, created_at, country, artists(name, slug)')
    .eq('livemode', isLiveMode())
    .is('tips_approved_at', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    Sentry.captureException(new Error(`tips-review-notify read failed: ${error.message}`));
    return { statusCode: 502, body: JSON.stringify({ error: 'Read failed' }) };
  }

  const rows = (data ?? []) as ReviewRow[];
  const current = new Set(rows.map(r => r.stripe_account_id));

  const redis = getRedis();
  if (!redis) {
    // No Upstash = no reliable "new" test: refuse to alert rather than re-alert the whole list.
    return { statusCode: 503, body: JSON.stringify({ error: 'Redis unavailable — no watermark, cannot classify' }) };
  }
  const previousRaw = await cacheGet<string[]>(watermarkKey());
  const previous = new Set(previousRaw ?? []);

  const fresh = rows.filter(r => !previous.has(r.stripe_account_id));
  if (fresh.length === 0) {
    // Refresh the watermark TTL so a quiet period doesn't let it expire and re-alert everyone.
    await cacheSet(watermarkKey(), [...current], WATERMARK_TTL_SECONDS);
    return { statusCode: 200, body: JSON.stringify({ ok: true, fresh: 0, awaiting: rows.length }) };
  }

  // Alert each new artist, then commit the watermark ONLY for the accounts we actually pushed.
  const alerted: string[] = [];
  for (const row of fresh) {
    const a = Array.isArray(row.artists) ? row.artists[0] : row.artists;
    const name = a?.name ?? row.stripe_account_id;
    const slug = a?.slug ?? '';
    if (await pushReviewAlert(name, slug, row.created_at)) {
      alerted.push(row.stripe_account_id);
    }
  }
  // The watermark only grows by accounts actually pushed: previous ones (still unapproved but
  // known) + the ones alerted here. A fresh account whose push failed stays unknown, so the
  // next run retries it instead of silently writing it off.
  const union = new Set([...previous, ...alerted]);
  await cacheSet(watermarkKey(), [...union], WATERMARK_TTL_SECONDS);

  const body = { ok: true, fresh: fresh.length, alerted: alerted.length, awaiting: rows.length };
  if (alerted.length !== fresh.length) {
    Sentry.captureMessage(`[tips-review-notify] alerted ${alerted.length}/${fresh.length} — push failures`, { extra: body });
  }
  return { statusCode: 200, body: JSON.stringify(body) };
}

export const handler = withSentry(handleRequest);