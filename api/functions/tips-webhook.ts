// API endpoint: POST /api/tips/webhook — Stripe Connect events for artist tips
// (docs/specs/artist-patronage-spec.md §9).
//
// Configure in Stripe as a *Connect* webhook ("events on connected accounts"), with its signing
// secret in STRIPE_CONNECT_WEBHOOK_SECRET. Events handled:
//   checkout.session.completed            a one-off tip was paid → tip_payments + support_entries,
//                                         and the fan's receipt (sendReceipt)
//   payment_intent.succeeded / .payment_failed   status sync
//   charge.refunded, charge.dispute.created      status sync; progress and totals drop them
//   account.updated                       mirror charges_enabled / details_submitted / country
//   account.application.deauthorized      the artist disconnected Unstream in Stripe → tips off
//
// Replays are no-ops: tip_payments.stripe_payment_intent_id is unique, and the ledger entry is
// written only by the request whose insert created the payment row. No rate limiter — Stripe is
// the only caller, and the signature is the authorization. Never logs event bodies.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { stripeRequest, verifyStripeSignature, type StripeEvent } from './stripe';
import { markArtistSupported } from './tips-db';
import { Sentry } from '../lib/sentry';

const HEADERS = { 'Content-Type': 'application/json' };
const ok = (note: string) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: true, note }) });

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  isBase64Encoded?: boolean;
}

export async function handler(event: HandlerEvent) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: '{"error":"Method not allowed"}' };

  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    Sentry.captureMessage('[tips-webhook] STRIPE_CONNECT_WEBHOOK_SECRET not set', { level: 'error' });
    return { statusCode: 500, headers: HEADERS, body: '{"error":"Not configured"}' };
  }

  // Netlify may hand the body over base64-encoded; the signature is over the raw bytes.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature'];
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return { statusCode: 400, headers: HEADERS, body: '{"error":"Invalid signature"}' };
  }

  let stripeEvent: StripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, headers: HEADERS, body: '{"error":"Invalid JSON"}' };
  }

  const client = getClient();
  if (!client) return { statusCode: 500, headers: HEADERS, body: '{"error":"Database not configured"}' };

  try {
    const note = await handleEvent(client, stripeEvent);
    return ok(note);
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient database failure.
    Sentry.captureException(err, { extra: { context: 'tips-webhook', eventType: stripeEvent.type, eventId: stripeEvent.id } });
    return { statusCode: 500, headers: HEADERS, body: '{"error":"Processing failed"}' };
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function handleEvent(client: SupabaseClient, evt: StripeEvent): Promise<string> {
  const obj = evt.data.object as Obj;
  switch (evt.type) {
    case 'checkout.session.completed':
      return recordCheckout(client, evt, obj);
    case 'payment_intent.succeeded':
      return setStatus(client, str(obj.id), 'succeeded');
    case 'payment_intent.payment_failed':
      return setStatus(client, str(obj.id), 'failed');
    case 'charge.refunded':
      return recordRefund(client, obj);
    case 'charge.dispute.created':
      return setStatus(client, str(obj.payment_intent), 'disputed');
    case 'account.updated':
      return syncAccount(client, evt, obj);
    case 'account.application.deauthorized':
      return disconnect(client, evt);
    default:
      return 'ignored';
  }
}

async function recordCheckout(client: SupabaseClient, evt: StripeEvent, session: Obj): Promise<string> {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  if (metadata.unstream_kind !== 'one_off') return 'not an Unstream tip';
  if (session.payment_status !== 'paid') return 'not paid yet';

  const paymentIntentId = str(session.payment_intent);
  const artistId = str(metadata.unstream_artist_id);
  const amountCents = Number(metadata.unstream_amount_cents);
  const grossCents = Number(session.amount_total);
  if (!paymentIntentId || !artistId || !Number.isInteger(amountCents) || !Number.isInteger(grossCents)) {
    throw new Error('checkout.session.completed missing Unstream metadata');
  }

  // The event must come from the account this artist connected, in this mode. Metadata alone is
  // not proof of whose payment it was.
  const { data: account, error: accountError } = await client
    .from('artist_tip_accounts')
    .select('artist_id')
    .eq('stripe_account_id', evt.account ?? '')
    .eq('livemode', evt.livemode)
    .maybeSingle();
  if (accountError) throw new Error(`artist_tip_accounts read failed: ${accountError.message}`);
  if (!account || (account as { artist_id: string }).artist_id !== artistId) {
    Sentry.captureMessage('[tips-webhook] checkout for an account that is not the artist’s', {
      level: 'error',
      extra: { eventId: evt.id },
    });
    return 'account mismatch';
  }

  // The fee this payment carries. Never recomputed from the artist's setting: they can change it
  // between the session being created and the fan paying, and the record has to match what Stripe
  // took (found 2026-10-03: a 5% session paid after a switch to 0% was recorded with no fee).
  // Checkout stores it in the metadata; a session created before it did (one paid across a deploy)
  // has none, so Stripe's own figure on the PaymentIntent is read instead.
  const applicationFeeCents = metadata.unstream_application_fee_cents !== undefined
    ? Number(metadata.unstream_application_fee_cents)
    : await chargedApplicationFee(paymentIntentId, evt.account!);
  if (!Number.isInteger(applicationFeeCents) || applicationFeeCents < 0 || applicationFeeCents > grossCents) {
    throw new Error('checkout.session.completed has an unusable application fee');
  }

  const fanUserId = str(metadata.unstream_fan_user_id);

  const { data: payment, error: insertError } = await client
    .from('tip_payments')
    .insert({
      artist_id: artistId,
      stripe_account_id: evt.account,
      stripe_payment_intent_id: paymentIntentId,
      amount_cents: Math.min(amountCents, grossCents),
      gross_cents: grossCents,
      application_fee_cents: applicationFeeCents,
      currency: str(session.currency) ?? 'usd',
      fan_user_id: fanUserId,
      channel: 'checkout',
      status: 'succeeded',
      livemode: evt.livemode,
    })
    .select('id')
    .single();

  if (insertError) {
    // 23505: this payment is already recorded — a replay, or payment_intent.succeeded got there
    // first. Either way the entry was (or will be) written by the insert that won.
    if (insertError.code === '23505') return 'already recorded';
    throw new Error(`tip_payments insert failed: ${insertError.message}`);
  }

  const paymentId = (payment as { id: string }).id;
  const { error: entryError } = await client.from('support_entries').insert({
    user_id: fanUserId,
    artist_id: artistId,
    amount_cents: Math.min(amountCents, grossCents),
    source: 'checkout',
    goal_id: str(metadata.unstream_goal_id),
    payment_id: paymentId,
  });
  if (entryError) throw new Error(`support_entries insert failed: ${entryError.message}`);

  // Only the insert that created the payment gets here, so a replayed event never re-sends it.
  await sendReceipt(evt.account!, paymentIntentId, session);

  // Spec §3.3: a signed-in fan's first successful payment marks the artist supported, if they
  // have them saved. Best effort — the payment is recorded either way.
  if (fanUserId) await markArtistSupported(client, fanUserId, artistId);
  return 'recorded';
}

/**
 * Make sure the fan gets a receipt. On a direct charge Stripe sends one only if the *artist* has
 * turned on receipts in their own Stripe settings, which Unstream can't see; a signed-out fan with no
 * receipt has no record of the payment and no address to ask for a refund. Setting `receipt_email` on
 * the charge makes Stripe send the artist's receipt whatever their settings (live mode only — test
 * mode never emails).
 *
 * The address is the one the fan typed into Checkout. It passes through here to Stripe and is never
 * stored or logged (spec §9: no fan PII). Skipped when the charge already has a receipt address or
 * a receipt number, i.e. Stripe sent one; if the artist's own receipt hasn't gone out by the time
 * this runs, the fan gets two, which beats none.
 *
 * Best effort: the payment is already recorded, and a failure here must not make Stripe retry the
 * event (the retry would stop at "already recorded" and never reach this anyway).
 */
async function sendReceipt(stripeAccount: string, paymentIntentId: string, session: Obj): Promise<void> {
  const details = (session.customer_details ?? {}) as Obj;
  const email = str(details.email);
  if (!email) return;
  try {
    const intent = await stripeRequest<{ latest_charge?: { id: string; receipt_email?: string | null; receipt_number?: string | null } | string | null }>(
      'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, { expand: ['latest_charge'] }, { stripeAccount },
    );
    const charge = intent.latest_charge;
    if (!charge || typeof charge === 'string') throw new Error('PaymentIntent has no expanded charge');
    if (charge.receipt_email || charge.receipt_number) return;
    await stripeRequest('POST', `/v1/charges/${encodeURIComponent(charge.id)}`, { receipt_email: email }, { stripeAccount });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: 'tips-webhook.sendReceipt', paymentIntentId } });
  }
}

/** What Stripe actually took as Unstream's fee on a payment: application_fee_amount, 0 when none. */
async function chargedApplicationFee(paymentIntentId: string, stripeAccount: string): Promise<number> {
  const intent = await stripeRequest<{ application_fee_amount?: number | null }>(
    'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {}, { stripeAccount },
  );
  return intent.application_fee_amount ?? 0;
}

/**
 * A refund — usually the artist's, from their own Stripe dashboard. A full refund drops the payment
 * out of goals and totals. Either way Unstream hands back its fee in proportion (spec §5, and the
 * artist addendum promises it): Stripe doesn't return a platform's fee when a connected account
 * refunds a direct charge, so without this it would stay in Unstream's balance (found 2026-10-03 in
 * the sandbox: a refunded $5.76 tip left the 29¢ fee unrefunded).
 *
 * Only a charge carrying an application fee is Unstream's tip — the artist's own sales on the same
 * account carry none and are left alone. Replays are safe: the amount still owed is worked out from
 * what Stripe has already refunded, and the request is idempotent on (fee, total owed).
 */
async function recordRefund(client: SupabaseClient, charge: Obj): Promise<string> {
  const note = charge.refunded === true
    ? await setStatus(client, str(charge.payment_intent), 'refunded')
    : 'partial refund, status left as is';

  const feeId = str(charge.application_fee);
  const amount = Number(charge.amount);
  const amountRefunded = Number(charge.amount_refunded);
  if (!feeId || !Number.isInteger(amount) || amount <= 0 || !Number.isInteger(amountRefunded)) return note;

  // The fee is a platform object, so these calls are on Unstream's own account (no Stripe-Account).
  const fee = await stripeRequest<{ amount: number; amount_refunded: number }>(
    'GET', `/v1/application_fees/${encodeURIComponent(feeId)}`,
  );
  const owed = Math.min(fee.amount, Math.round(fee.amount * amountRefunded / amount));
  const toReturn = owed - fee.amount_refunded;
  if (toReturn <= 0) return `${note}; fee already returned`;
  await stripeRequest(
    'POST', `/v1/application_fees/${encodeURIComponent(feeId)}/refunds`,
    { amount: toReturn },
    { idempotencyKey: `fee-refund:${feeId}:${owed}` },
  );
  return `${note}; returned ${toReturn}¢ of Unstream's fee`;
}

async function setStatus(client: SupabaseClient, paymentIntentId: string | null, status: string): Promise<string> {
  if (!paymentIntentId) return 'no payment intent';
  const { error } = await client.from('tip_payments').update({ status }).eq('stripe_payment_intent_id', paymentIntentId);
  if (error) throw new Error(`tip_payments status update failed: ${error.message}`);
  return `status ${status}`;
}

async function syncAccount(client: SupabaseClient, evt: StripeEvent, account: Obj): Promise<string> {
  const accountId = str(account.id);
  if (!accountId) return 'no account id';
  const { error } = await client.from('artist_tip_accounts')
    .update({
      charges_enabled: account.charges_enabled === true,
      details_submitted: account.details_submitted === true,
      country: str(account.country),
    })
    .eq('stripe_account_id', accountId)
    .eq('livemode', evt.livemode);
  if (error) throw new Error(`artist_tip_accounts sync failed: ${error.message}`);
  return 'account synced';
}

/**
 * A Standard account can disconnect the platform from its own Stripe dashboard. Tips stop at once;
 * the row stays (it records who connected what), and reconnecting needs a fresh approval.
 */
async function disconnect(client: SupabaseClient, evt: StripeEvent): Promise<string> {
  if (!evt.account) return 'no account';
  const { error } = await client.from('artist_tip_accounts')
    .update({ charges_enabled: false, tips_enabled: false, tips_approved_at: null })
    .eq('stripe_account_id', evt.account)
    .eq('livemode', evt.livemode);
  if (error) throw new Error(`artist_tip_accounts disconnect failed: ${error.message}`);
  return 'disconnected';
}
