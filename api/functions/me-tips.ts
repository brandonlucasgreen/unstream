// API endpoint: /api/me/tips — a fan's own record of the tips they've left.
//
//   GET                                the signed-in fan's tips, newest first (the Settings section)
//   POST { sessionId, artistSlug }     save a tip paid while signed out to this account
//
// Tipping never needs an account (spec §3.1), so the sign-in nudge comes *after* paying: Stripe
// returns the fan to /tip/thanks with the Checkout Session id, and if they sign in there, the page
// claims that tip with it. The session id is the proof: it only ever appears in the return URL of
// the browser that paid. A claim attaches the tip to an account and nothing more — no money moves —
// so the remaining risk (someone else holding that URL) is bounded by accepting only sessions under a
// day old that nobody has claimed yet.
//
// Follows the other me-* endpoints (resolveAccountRequest, the account limiter, hand-rolled CORS)
// and is in api/tsconfig.json's typecheck include — keep it there. Reads filter on the Stripe mode
// of the configured key, so a test tip made through `npm run dev` never shows on the real site.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { isLiveMode, stripeMode, stripeRequest, StripeError, type StripeCheckoutSession } from './stripe';
import { markArtistSupported } from './tips-db';
import { keptAfterRefund } from '../shared/tips';
import { Sentry, withSentry } from '../lib/sentry';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SESSION_ID_REGEX = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** How long after paying a signed-out tip can still be saved to an account. */
export const CLAIM_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * More than any fan will reach for a long time. PostgREST would truncate silently at 1,000, so the
 * cap is explicit here instead, newest first.
 */
const TIP_HISTORY_LIMIT = 500;

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
}

interface JsonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const respond = (statusCode: number, body: unknown): JsonResponse =>
  ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });

async function handleRequest(event: HandlerEvent): Promise<JsonResponse> {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as JsonResponse;

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!user) return respond(401, { error: 'Not signed in' });

  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });

  try {
    if (event.httpMethod === 'GET') return respond(200, { tips: await listTips(client, user.userId) });
    return await claimTip(client, user.userId, event.body ?? null);
  } catch (err) {
    Sentry.captureException(err, {
      extra: { context: `me-tips.${event.httpMethod}`, stripeCode: err instanceof StripeError ? err.code : undefined },
    });
    return respond(502, {
      error: event.httpMethod === 'GET'
        ? "Couldn't load your tips. Try again in a moment."
        : "Couldn't save this tip to your account. Try again in a moment.",
    });
  }
}

interface TipRow {
  id: string;
  amount_cents: number;
  gross_cents: number;
  refunded_cents: number;
  currency: string;
  status: string;
  created_at: string;
  artists: { name: string; slug: string } | null;
  support_entries: Array<{ artist_goals: { title: string } | null }> | null;
}

export interface FanTip {
  id: string;
  artistName: string;
  artistSlug: string;
  /** What the fan chose to give the artist. */
  amountCents: number;
  /** What the fan paid, including any fees they covered. */
  paidCents: number;
  /** How much of paidCents the artist refunded; 0 for most tips. */
  refundedCents: number;
  /**
   * What counts as given of amountCents, the way goals and the artist's totals count it: less any
   * refunded share, and 0 for a tip that was fully refunded or is disputed.
   */
  netAmountCents: number;
  currency: string;
  status: string;
  goalTitle: string | null;
  createdAt: string;
}

async function listTips(client: SupabaseClient, userId: string): Promise<FanTip[]> {
  // No Stripe key means tips are switched off, and there is no mode to read in.
  if (!stripeMode()) return [];

  const { data, error } = await client
    .from('tip_payments')
    .select('id, amount_cents, gross_cents, refunded_cents, currency, status, created_at, artists(name, slug), support_entries(artist_goals(title))')
    .eq('fan_user_id', userId)
    .eq('livemode', isLiveMode())
    // A payment that never went through isn't a tip the fan left.
    .in('status', ['succeeded', 'refunded', 'disputed'])
    .order('created_at', { ascending: false })
    .limit(TIP_HISTORY_LIMIT);
  if (error) throw new Error(`tip_payments read failed: ${error.message}`);

  return ((data ?? []) as unknown as TipRow[]).map(row => ({
    id: row.id,
    artistName: row.artists?.name ?? 'Unknown artist',
    artistSlug: row.artists?.slug ?? '',
    amountCents: row.amount_cents,
    paidCents: row.gross_cents,
    refundedCents: row.refunded_cents ?? 0,
    netAmountCents: row.status !== 'succeeded' ? 0 : keptAfterRefund(row.amount_cents, row.gross_cents, row.refunded_cents ?? 0),
    currency: row.currency,
    status: row.status,
    goalTitle: row.support_entries?.find(e => e.artist_goals)?.artist_goals?.title ?? null,
    createdAt: row.created_at,
  }));
}

/**
 * Save a signed-out tip to this account. Answers:
 *   200 { status: 'saved' }     it's on this account now (or already was)
 *   202 { status: 'pending' }   Stripe has the payment but the webhook hasn't recorded it yet — retry
 *   404 / 409 / 410             not a tip we can save (unknown, someone else's, or too old)
 */
async function claimTip(client: SupabaseClient, userId: string, rawBody: string | null): Promise<JsonResponse> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const artistSlug = typeof body.artistSlug === 'string' ? body.artistSlug : '';
  if (!SESSION_ID_REGEX.test(sessionId) || !SLUG_REGEX.test(artistSlug)) return respond(400, { error: 'Invalid tip' });
  if (!stripeMode()) return respond(503, { error: 'Tips are not available right now' });

  const notFound = respond(404, { error: "We couldn't find that tip." });

  const { data: artist, error: artistError } = await client
    .from('artists')
    .select('id')
    .eq('slug', artistSlug)
    .maybeSingle();
  if (artistError) throw new Error(`artist read failed: ${artistError.message}`);
  if (!artist) return notFound;
  const artistId = (artist as { id: string }).id;

  // The session lives on the artist's connected account, so that's where it's read from. The row
  // stays after an artist switches tips off, so a tip paid just before can still be saved.
  const { data: account, error: accountError } = await client
    .from('artist_tip_accounts')
    .select('stripe_account_id')
    .eq('artist_id', artistId)
    .eq('livemode', isLiveMode())
    .maybeSingle();
  if (accountError) throw new Error(`artist_tip_accounts read failed: ${accountError.message}`);
  if (!account) return notFound;

  let session: StripeCheckoutSession;
  try {
    session = await stripeRequest<StripeCheckoutSession>(
      'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {},
      { stripeAccount: (account as { stripe_account_id: string }).stripe_account_id },
    );
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return notFound;
    throw err;
  }

  // Everything is checked against what Stripe says, not what the request claimed.
  const metadata = session.metadata ?? {};
  if (
    metadata.unstream_kind !== 'one_off' ||
    metadata.unstream_artist_id !== artistId ||
    session.payment_status !== 'paid' ||
    session.livemode !== isLiveMode() ||
    !session.payment_intent
  ) {
    return notFound;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - (session.created ?? 0);
  if (ageSeconds > CLAIM_WINDOW_SECONDS) {
    return respond(410, { error: 'Tips can only be saved to an account within a day of paying.' });
  }

  const { data: payment, error: paymentError } = await client
    .from('tip_payments')
    .select('id, fan_user_id')
    .eq('stripe_payment_intent_id', session.payment_intent)
    .eq('livemode', isLiveMode())
    .maybeSingle();
  if (paymentError) throw new Error(`tip_payments read failed: ${paymentError.message}`);
  if (!payment) return respond(202, { status: 'pending' });

  const { id: paymentId, fan_user_id: owner } = payment as { id: string; fan_user_id: string | null };
  const alreadyClaimed = respond(409, { error: 'This tip is already saved to another account.' });
  if (owner && owner !== userId) return alreadyClaimed;

  if (!owner) {
    // Guarded on the owner still being empty, so two accounts claiming at once can't both win.
    const { data: claimed, error: claimError } = await client
      .from('tip_payments')
      .update({ fan_user_id: userId })
      .eq('id', paymentId)
      .is('fan_user_id', null)
      .select('id');
    if (claimError) throw new Error(`tip_payments claim failed: ${claimError.message}`);
    if (!claimed || (claimed as unknown[]).length === 0) return alreadyClaimed;
  }

  // The ledger entry follows its payment, so goal contributions and Year in support see the fan too.
  // Run on every claim of a tip that's this fan's, not just the first, so a retry after this step
  // failed finishes the job; when there's nothing left to update it changes no rows.
  const { error: entryError } = await client
    .from('support_entries')
    .update({ user_id: userId })
    .eq('payment_id', paymentId)
    .is('user_id', null);
  if (entryError) throw new Error(`support_entries claim failed: ${entryError.message}`);

  await markArtistSupported(client, userId, artistId);
  return respond(200, { status: 'saved' });
}

export const handler = withSentry(handleRequest);
