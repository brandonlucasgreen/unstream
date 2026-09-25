// API endpoint: /api/membership/checkout
//
// POST { plan: 'monthly' | 'annual' | 'lifetime' } — creates a hosted Stripe Checkout Session
// for the signed-in user and returns { url } to redirect to. Spec:
// docs/specs/open-books-membership-spec.md §4 and §8.
//
// - Sign-in is required (Brandon, 2026-09-25). The session carries client_reference_id =
//   user id, so the webhook links the purchase to the account without Unstream ever storing
//   the buyer's email.
// - Managed Payments is on: Stripe is merchant of record and handles VAT and sales tax.
// - Hosted Checkout is a top-level navigation, so no Stripe.js and no CSP change.

import { Sentry } from '../lib/sentry';
import { getMembership, isMembershipActive, isPurchasablePlan } from './membership';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';
import { getStripe, priceIdForPlan, siteUrl } from './stripe-client';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;
  if (!user) return json(401, { error: 'Sign in to become a member' });

  let plan: unknown;
  try {
    plan = (JSON.parse(event.body || '{}') as { plan?: unknown }).plan;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!isPurchasablePlan(plan)) return json(400, { error: 'Unknown plan' });

  const stripe = getStripe();
  const priceId = priceIdForPlan(plan);
  if (!stripe || !priceId) {
    Sentry.captureMessage('membership-checkout: Stripe key or price id not configured', 'error');
    return json(503, { error: 'Membership isn’t available right now' });
  }

  try {
    const existing = await getMembership(user.userId);
    // A grandfathered member may still choose to pay; anyone else already has a membership,
    // and a second checkout would bill them twice.
    if (isMembershipActive(existing) && existing?.plan !== 'grandfathered') {
      return json(409, { error: 'You’re already a member' });
    }

    const site = siteUrl();
    const metadata = { user_id: user.userId, plan };
    const session = await stripe.checkout.sessions.create({
      mode: plan === 'lifetime' ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      managed_payments: { enabled: true },
      client_reference_id: user.userId,
      metadata,
      // Reuse the Stripe customer of someone coming back after cancelling, so their history
      // and receipts stay in one place; otherwise prefill the account email.
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: user.email || undefined }),
      ...(plan === 'lifetime'
        ? { customer_creation: 'always' as const }
        : { subscription_data: { metadata } }),
      success_url: `${site}/open-books?membership=thanks`,
      cancel_url: `${site}/open-books`,
    });

    if (!session.url) throw new Error('Checkout session has no url');
    return json(200, { url: session.url });
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'membership-checkout.create', plan } });
    return json(502, { error: 'Could not start checkout' });
  }
}
