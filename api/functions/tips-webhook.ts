// API endpoint: POST /api/tips/webhook — Stripe Connect events for artist tips
// (docs/specs/artist-patronage-spec.md §9).
//
// Configure in Stripe as a *Connect* webhook ("events on connected accounts"), with its signing
// secret in STRIPE_CONNECT_WEBHOOK_SECRET. Events to subscribe, and what each does:
//   checkout.session.completed            a one-off tip was paid → tip_payments + support_entries,
//                                         and the fan's receipt (sendReceipt)
//   charge.refunded                       refunded_cents, 'refunded' once fully refunded; Unstream's
//                                         fee handed back in proportion
//   charge.refund.updated                 a refund that failed or was canceled: recount from the charge
//   charge.dispute.created / .closed      'disputed'; back to 'succeeded' if the artist wins, and
//                                         Unstream's fee handed back if they lose
//   account.updated                       mirror charges_enabled / details_submitted / country
//   account.application.deauthorized      the artist disconnected Unstream in Stripe → tips off
//
// Stripe doesn't deliver events in order, so a payment's status only ever moves forward:
// succeeded → refunded or disputed, disputed → succeeded only through a won dispute, and nothing
// leaves 'refunded' except a refund that failed (the money went back to the artist). Every status
// write is conditional on the status it moves from, so a late or replayed event changes nothing.
// payment_intent.* events aren't needed: a row is only ever created, as 'succeeded', by
// checkout.session.completed, so they're ignored if the endpoint still sends them.
//
// Replays are no-ops: tip_payments.stripe_payment_intent_id is unique, and the ledger entry is
// written only by the request whose insert created the payment row. No rate limiter — Stripe is
// the only caller, and the signature is the authorization. Never logs event bodies.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { isLiveMode, stripeRequest, verifyStripeSignature, type StripeCharge, type StripeEvent } from './stripe';
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
  // A live Connect endpoint also receives test-mode events from connected accounts (and a test
  // endpoint can see live ones). Only the mode of the key this server holds is ever recorded.
  if (evt.livemode !== isLiveMode()) return 'other mode';

  const obj = evt.data.object as Obj;
  switch (evt.type) {
    case 'checkout.session.completed':
      return recordCheckout(client, evt, obj);
    case 'charge.refunded':
      return recordRefund(client, obj);
    case 'charge.refund.updated':
      return refundUpdated(client, evt, obj);
    case 'charge.dispute.created':
      return moveStatus(client, str(obj.payment_intent), ['succeeded'], 'disputed');
    case 'charge.dispute.closed':
      return disputeClosed(client, evt, obj);
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
    // 23505: this payment is already recorded — Stripe replayed the event, or delivered it twice
    // at once. The ledger entry was (or is being) written by the request whose insert won.
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
 * A refund — usually the artist's, from their own Stripe dashboard. `refunded_cents` follows the
 * charge's amount_refunded, and every money figure (goal progress, the artist's totals, a fan's list)
 * counts what's left in proportion (keptAfterRefund). A full refund also marks the payment
 * 'refunded', which drops it out of all of them.
 *
 * The ledger entry is left as written on a partial refund, deliberately: support_entries is
 * append-only and voiding is all-or-nothing, so the refunded share is derived at read time from its
 * payment instead (get_goal_progress), and a refund that later fails needs nothing undone.
 *
 * Either way Unstream hands back its fee in proportion (spec §5, and the artist addendum promises
 * it): Stripe doesn't return a platform's fee when a connected account refunds a direct charge, so
 * without this it would stay in Unstream's balance (found 2026-10-03 in the sandbox: a refunded
 * $5.76 tip left the 29¢ fee unrefunded).
 *
 * Only a charge carrying an application fee is Unstream's tip — the artist's own sales on the same
 * account carry none and are left alone. Replays are safe: refunded_cents only grows here, and the
 * fee owed is worked out from what Stripe has already returned.
 */
async function recordRefund(client: SupabaseClient, charge: Obj): Promise<string> {
  const paymentIntentId = str(charge.payment_intent);
  const amount = Number(charge.amount);
  const amountRefunded = Number(charge.amount_refunded);
  if (!paymentIntentId || !Number.isInteger(amount) || amount <= 0 || !Number.isInteger(amountRefunded)) {
    return 'not a usable charge';
  }

  // Out of order, an earlier (smaller) refund total can arrive after a later one: only ever raise it.
  const { error } = await client.from('tip_payments')
    .update({ refunded_cents: amountRefunded })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .lt('refunded_cents', amountRefunded);
  if (error) throw new Error(`tip_payments refund update failed: ${error.message}`);

  const fullyRefunded = charge.refunded === true || amountRefunded >= amount;
  const note = fullyRefunded
    ? await moveStatus(client, paymentIntentId, ['succeeded'], 'refunded')
    : 'partial refund recorded';

  const feeId = str(charge.application_fee);
  if (!feeId) return note;
  const returned = await returnApplicationFee(
    feeId, fee => Math.min(fee.amount, Math.round(fee.amount * amountRefunded / amount)), 'fee-refund',
  );
  return returned > 0 ? `${note}; returned ${returned}¢ of Unstream's fee` : `${note}; fee already returned`;
}

/**
 * A refund that failed (the fan's card couldn't take it) or was canceled puts the money back in the
 * artist's balance, so the tip counts again. The charge is re-read for its current amount_refunded,
 * which may be lower than what's stored — the one case refunded_cents goes down, and the one case
 * a payment leaves 'refunded'. Unstream's fee, if it was already handed back, stays with the artist.
 */
async function refundUpdated(client: SupabaseClient, evt: StripeEvent, refund: Obj): Promise<string> {
  if (refund.status !== 'failed' && refund.status !== 'canceled') return 'refund still going';
  const paymentIntentId = str(refund.payment_intent);
  const chargeId = str(refund.charge);
  if (!paymentIntentId || !chargeId || !evt.account) return 'no charge';

  // Looked up first, so a failed refund on the artist's own sales costs no Stripe call.
  const { data: payment, error: readError } = await client.from('tip_payments')
    .select('id, status')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .eq('livemode', evt.livemode)
    .maybeSingle();
  if (readError) throw new Error(`tip_payments read failed: ${readError.message}`);
  if (!payment) return 'not an Unstream tip';

  const charge = await stripeRequest<StripeCharge>(
    'GET', `/v1/charges/${encodeURIComponent(chargeId)}`, {}, { stripeAccount: evt.account },
  );
  const { error } = await client.from('tip_payments')
    .update({ refunded_cents: charge.amount_refunded })
    .eq('id', (payment as { id: string }).id);
  if (error) throw new Error(`tip_payments refund update failed: ${error.message}`);

  if (charge.amount_refunded < charge.amount) {
    await moveStatus(client, paymentIntentId, ['refunded'], 'succeeded');
  }
  return 'refund recounted';
}

/**
 * A dispute is over. Won (or an inquiry closed with a warning): the money stayed with the artist,
 * so the tip counts again. Lost: the fan's bank took it back, the payment stays 'disputed', and
 * Unstream returns the rest of its fee to the artist — artists first; Unstream doesn't keep a cut of
 * a tip the artist never got to keep.
 */
async function disputeClosed(client: SupabaseClient, evt: StripeEvent, dispute: Obj): Promise<string> {
  const paymentIntentId = str(dispute.payment_intent);
  if (dispute.status === 'won' || dispute.status === 'warning_closed') {
    return moveStatus(client, paymentIntentId, ['disputed'], 'succeeded');
  }
  if (dispute.status !== 'lost') return `dispute ${String(dispute.status)}`;

  const chargeId = str(dispute.charge);
  if (!chargeId || !evt.account) return 'dispute lost';
  const charge = await stripeRequest<StripeCharge>(
    'GET', `/v1/charges/${encodeURIComponent(chargeId)}`, {}, { stripeAccount: evt.account },
  );
  const feeId = str(charge.application_fee);
  if (!feeId) return 'dispute lost';
  const returned = await returnApplicationFee(feeId, fee => fee.amount, 'fee-dispute');
  return returned > 0 ? `dispute lost; returned ${returned}¢ of Unstream's fee` : 'dispute lost; fee already returned';
}

/**
 * Hand back Unstream's application fee up to `owedTotal` of it, counting what Stripe has already
 * returned. The fee is a platform object, so these calls are on Unstream's own account (no
 * Stripe-Account). The idempotency key is the fee and the total owed, so a concurrent duplicate
 * event makes the same request and Stripe applies it once. Returns the cents handed back now.
 */
async function returnApplicationFee(
  feeId: string,
  owedTotal: (fee: { amount: number; amount_refunded: number }) => number,
  keyPrefix: string,
): Promise<number> {
  const fee = await stripeRequest<{ amount: number; amount_refunded: number }>(
    'GET', `/v1/application_fees/${encodeURIComponent(feeId)}`,
  );
  const owed = owedTotal(fee);
  const toReturn = owed - fee.amount_refunded;
  if (toReturn <= 0) return 0;
  await stripeRequest(
    'POST', `/v1/application_fees/${encodeURIComponent(feeId)}/refunds`,
    { amount: toReturn },
    { idempotencyKey: `${keyPrefix}:${feeId}:${owed}` },
  );
  return toReturn;
}

/** Move a payment's status, but only from one of `from`: a late or replayed event is a no-op. */
async function moveStatus(client: SupabaseClient, paymentIntentId: string | null, from: string[], to: string): Promise<string> {
  if (!paymentIntentId) return 'no payment intent';
  const { data, error } = await client.from('tip_payments')
    .update({ status: to })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .in('status', from)
    .select('id');
  if (error) throw new Error(`tip_payments status update failed: ${error.message}`);
  return data && (data as unknown[]).length > 0 ? `status ${to}` : `status unchanged (not ${from.join('/')})`;
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
 * the row stays (it records who connected what) with deauthorized_at set, which tips-connect reads
 * as "no account": reconnecting creates a new Stripe account, re-accepts the addendum and needs a
 * fresh approval.
 */
async function disconnect(client: SupabaseClient, evt: StripeEvent): Promise<string> {
  if (!evt.account) return 'no account';
  const { error } = await client.from('artist_tip_accounts')
    .update({ charges_enabled: false, tips_enabled: false, tips_approved_at: null, deauthorized_at: new Date().toISOString() })
    .eq('stripe_account_id', evt.account)
    .eq('livemode', evt.livemode);
  if (error) throw new Error(`artist_tip_accounts disconnect failed: ${error.message}`);
  return 'disconnected';
}
