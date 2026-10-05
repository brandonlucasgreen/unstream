// API endpoint: /api/tips/checkout — one-off tips through hosted Stripe Checkout
// (docs/specs/artist-patronage-spec.md §3.1, §4, §5).
//
//   GET  ?slug=   what the tip page needs: the artist, whether they take tips, their fee, open goals
//   POST { artistSlug, amountCents, coverFees, goalId? }  → { url, breakdown }
//
// The payment is a *direct charge on the artist's own connected account* (Stripe-Account header),
// so the artist is the seller and the money lands in their balance. Unstream's only share is the
// artist-chosen application fee, which may be zero. Nothing is held or forwarded (spec §2).
//
// The client sends an amount and a checkbox; everything else — eligibility, the fee, the gross-up,
// the goal — is decided here from the database, never taken from the request.
//
// Signed-in fans may send their Bearer token so the tip is attributed to them (their goal
// contributions, "supported" on their saved artist). Signed-out fans can tip too.
//
// Anonymous and public, so CORS is restricted to unstream.stream (buildCorsHeaders), like the
// site's other anonymous endpoints: no other site's page should be able to start a payment form.
// Stripe's own error messages never reach a fan; Sentry gets them.

import { getClient } from './db';
import { authenticateBearerFast, buildCorsHeaders } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isStripeRejection, stripeRequest, StripeError, type StripeCheckoutSession } from './stripe';
import { getGoals, tipEligibility } from './tips-db';
import { respond, siteUrl } from './tips-http';
import {
  ONE_OFF_MAX_CENTS,
  ONE_OFF_MIN_CENTS,
  ONE_OFF_PRESETS_CENTS,
  canChargeApplicationFee,
  formatUsd,
  isValidOneOffAmount,
  tipBreakdown,
} from '../shared/tips';
import { Sentry, withSentry } from '../lib/sentry';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const withCors = (res: { statusCode: number; body: string }) => ({ ...res, headers: CORS_HEADERS });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const ip = getClientIp(event.headers);
  // POST creates a payment form, so it gets the strict limiter (card-testing defence, spec §9);
  // GET only reads the page's data.
  const rl = await checkRateLimit(`ip:${ip}`, event.httpMethod === 'POST' ? 'strict' : 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response!;

  try {
    if (event.httpMethod === 'GET') return withCors(await readTipPage(event.queryStringParameters?.slug ?? ''));
    if (event.httpMethod === 'POST') return withCors(await createCheckout(event));
    return withCors(respond(405, { error: 'Method not allowed' }));
  } catch (err) {
    Sentry.captureException(err, {
      extra: {
        context: `tips-checkout.${event.httpMethod}`,
        stripeStatus: err instanceof StripeError ? err.status : undefined,
        stripeCode: err instanceof StripeError ? err.code : undefined,
      },
    });
    // Stripe refusing the session (a 4xx) means something about the artist's account: retrying
    // won't help the fan, so don't ask them to.
    if (isStripeRejection(err)) return withCors(respond(409, { error: "This artist can't take tips right now." }));
    return withCors(respond(502, { error: "Couldn't start the payment. Try again in a moment." }));
  }
}

async function readTipPage(slug: string) {
  if (!SLUG_REGEX.test(slug)) return respond(400, { error: 'Invalid artist' });
  const eligibility = await tipEligibility(slug);
  if (!eligibility.ok && !eligibility.artist) return respond(eligibility.status, { error: eligibility.reason });

  const artist = eligibility.artist!;
  if (!eligibility.ok) {
    return respond(200, { artist, takingTips: false });
  }
  const client = getClient()!;
  return respond(200, {
    artist,
    takingTips: true,
    feeBasisPoints: effectiveFeeBasisPoints(eligibility.account),
    goals: await getGoals(client, artist.id, { openOnly: true }),
    presetsCents: ONE_OFF_PRESETS_CENTS,
    minCents: ONE_OFF_MIN_CENTS,
    maxCents: ONE_OFF_MAX_CENTS,
  });
}

async function createCheckout(event: HandlerEvent) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const slug = typeof body.artistSlug === 'string' ? body.artistSlug : '';
  if (!SLUG_REGEX.test(slug)) return respond(400, { error: 'Invalid artist' });
  if (!isValidOneOffAmount(body.amountCents)) {
    return respond(400, { error: `Tips are between ${formatUsd(ONE_OFF_MIN_CENTS)} and ${formatUsd(ONE_OFF_MAX_CENTS)}` });
  }
  const amountCents = body.amountCents;
  const coverFees = body.coverFees !== false; // on by default (spec §5)

  const eligibility = await tipEligibility(slug);
  if (!eligibility.ok) return respond(eligibility.status, { error: eligibility.reason });
  const { artist, account } = eligibility;

  let goalId: string | null = null;
  if (body.goalId !== undefined && body.goalId !== null && body.goalId !== '') {
    if (typeof body.goalId !== 'string' || !UUID_REGEX.test(body.goalId)) return respond(400, { error: 'Invalid goal' });
    const open = await getGoals(getClient()!, artist.id, { openOnly: true });
    if (!open.some(g => g.id === body.goalId)) return respond(400, { error: 'That goal is closed' });
    goalId = body.goalId;
  }

  // Optional attribution. A bad token is ignored rather than refused: the tip still works.
  const fan = event.headers.authorization ? await authenticateBearerFast(event.headers.authorization).catch(() => null) : null;

  const breakdown = tipBreakdown(amountCents, coverFees, effectiveFeeBasisPoints(account));

  // Everything the webhook needs to record the payment, on the PaymentIntent (which the charge
  // events carry) and the Session (which checkout.session.completed carries).
  const metadata: Record<string, string> = {
    unstream_kind: 'one_off',
    unstream_artist_id: artist.id,
    unstream_amount_cents: String(amountCents),
    // The fee this payment carries, so the webhook records what Stripe actually took even if the
    // artist changes their fee before the fan finishes paying.
    unstream_application_fee_cents: String(breakdown.applicationFeeCents),
    ...(goalId ? { unstream_goal_id: goalId } : {}),
    ...(fan ? { unstream_fan_user_id: fan.userId } : {}),
  };

  const session = await stripeRequest<StripeCheckoutSession>('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: breakdown.grossCents,
        product_data: {
          name: `Support for ${artist.name}'s music`,
          description: coverFees
            ? `${formatUsd(amountCents)} for ${artist.name}, plus ${formatUsd(breakdown.grossCents - amountCents)} to cover fees`
            : `${formatUsd(amountCents)} for ${artist.name}`,
        },
      },
    }],
    payment_method_types: ['card'],
    payment_intent_data: {
      application_fee_amount: breakdown.applicationFeeCents > 0 ? breakdown.applicationFeeCents : null,
      description: `Support for ${artist.name}'s music via Unstream`,
      metadata,
    },
    metadata,
    success_url: `${siteUrl()}/tip/thanks?artist=${encodeURIComponent(artist.slug)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/tip/${encodeURIComponent(artist.slug)}`,
  }, { stripeAccount: account.stripe_account_id });

  if (!session.url) throw new Error('Checkout Session has no url');
  return respond(200, { url: session.url, breakdown });
}

/**
 * The fee this artist's tips carry: their chosen fee, except where Stripe doesn't allow a platform
 * fee on the account's country (NO_APPLICATION_FEE_COUNTRIES), where it's 0 whatever is stored.
 * The tip page shows the same figure, so the breakdown the fan sees is what Stripe is sent.
 */
function effectiveFeeBasisPoints(account: { fee_basis_points: number; country: string | null }): number {
  return canChargeApplicationFee(account.country) ? account.fee_basis_points : 0;
}

export const handler = withSentry(handleRequest);
