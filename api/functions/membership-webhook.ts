// API endpoint: /api/membership/webhook
//
// POST — Stripe webhook for Open House memberships. Keeps the `memberships` table in step with
// Stripe. Spec: docs/specs/open-house-membership-spec.md §8.
//
// - The Stripe signature is the only authentication: no bearer auth, no CORS, and no rate
//   limiter (which would spend Redis commands on a caller who's already been verified).
// - Netlify can hand the body over base64-encoded; it must be decoded to the exact bytes
//   Stripe signed, or every signature check fails.
// - Subscription state is re-read from Stripe rather than taken from the event, so events
//   arriving out of order or replayed can only ever write Stripe's current truth. The rules
//   for which writes win live in membership.ts (rowFromSubscription).
// - Never log the event body: it holds the buyer's email and address. Type and id only.
//
// Local testing: Stripe test-mode keys and `stripe listen --forward-to
// localhost:8888/api/membership/webhook`. `npm run dev` writes to PRODUCTION Supabase, so use a
// throwaway account and delete its `memberships` row afterwards.

import type Stripe from 'stripe';
import { Sentry } from '../lib/sentry';
import {
  getMembership,
  getUserIdForCustomer,
  rowFromLifetimePurchase,
  rowFromSubscription,
  upsertMembership,
  type SubscriptionSnapshot,
} from './membership';
import { getStripe } from './stripe-client';

const HEADERS = { 'Content-Type': 'application/json' };

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function idOf(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function snapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const item = sub.items.data[0];
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? '',
    status: sub.status,
    currentPeriodEnd: item?.current_period_end ?? null,
    interval: item?.price.recurring?.interval ?? null,
    unitAmount: item?.price.unit_amount ?? null,
    currency: item?.price.currency ?? null,
    canceledAt: sub.canceled_at,
  };
}

/** Re-read a subscription and write the row it implies for its owner. */
async function syncSubscription(stripe: Stripe, subscriptionId: string, knownUserId: string | null) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(sub.customer);
  const userId =
    knownUserId ?? sub.metadata?.user_id ?? (customerId ? await getUserIdForCustomer(customerId) : null);

  if (!userId) {
    // Nothing to attach it to. A 200 stops Stripe retrying for days against something that
    // can't succeed; Sentry is where this gets looked at.
    Sentry.captureMessage('membership-webhook: subscription with no known user', {
      level: 'warning',
      extra: { subscriptionId },
    });
    return;
  }

  const row = rowFromSubscription(userId, snapshot(sub), await getMembership(userId));
  if (row) await upsertMembership(row);
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const userId = session.client_reference_id;
  if (!userId) {
    Sentry.captureMessage('membership-webhook: checkout session without client_reference_id', {
      level: 'warning',
      extra: { sessionId: session.id },
    });
    return;
  }

  if (session.mode === 'subscription') {
    const subscriptionId = idOf(session.subscription);
    if (subscriptionId) await syncSubscription(stripe, subscriptionId, userId);
    return;
  }

  // One-off purchase: the lifetime plan. Only a paid session counts — an async payment
  // method can complete checkout before the money arrives.
  if (session.mode === 'payment' && session.payment_status === 'paid' && session.metadata?.plan === 'lifetime') {
    await upsertMembership(
      rowFromLifetimePurchase(userId, idOf(session.customer), session.amount_subtotal, session.currency)
    );
  }
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  isBase64Encoded?: boolean;
}) {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const stripe = getStripe();
  const secret = process.env.STRIPE_MEMBERSHIP_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    Sentry.captureMessage('membership-webhook: Stripe key or webhook secret not configured', 'error');
    // 500 so Stripe keeps retrying until the configuration is fixed, rather than dropping events.
    return respond(500, { error: 'Not configured' });
  }

  const signature = event.headers['stripe-signature'];
  if (!signature || !event.body) return respond(400, { error: 'Missing signature or body' });

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // Forged, stale or re-encoded. Nothing about the request is worth logging.
    return respond(400, { error: 'Invalid signature' });
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(stripe, stripeEvent.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(stripe, stripeEvent.data.object.id, null);
        break;
      default:
        // Subscribed to more than we handle, or Stripe sent something new: acknowledge it.
        // Failed renewals arrive as customer.subscription.updated (status past_due), so
        // invoice.* events need no handler of their own.
        break;
    }
  } catch (error) {
    // A database or Stripe read failed. 500 makes Stripe retry, which is what we want: every
    // handler writes absolute state, so a retry can't double-apply anything.
    Sentry.captureException(error, {
      extra: { context: 'membership-webhook', eventType: stripeEvent.type, eventId: stripeEvent.id },
    });
    return respond(500, { error: 'Processing failed' });
  }

  return respond(200, { received: true });
}
