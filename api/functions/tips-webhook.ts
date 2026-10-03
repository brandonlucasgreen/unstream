// API endpoint: POST /api/tips/webhook — Stripe Connect events for artist tips
// (docs/specs/artist-patronage-spec.md §9).
//
// Configure in Stripe as a *Connect* webhook ("events on connected accounts"), with its signing
// secret in STRIPE_CONNECT_WEBHOOK_SECRET. Events handled:
//   checkout.session.completed            a one-off tip was paid → tip_payments + support_entries
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
import { verifyStripeSignature, type StripeEvent } from './stripe';
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
      return obj.refunded === true ? setStatus(client, str(obj.payment_intent), 'refunded') : 'partial refund, left as is';
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
  // The fee checkout put on this payment. Not recomputed from the artist's setting: they can change
  // it between the session being created and the fan paying, and the record has to match what Stripe
  // took (found 2026-10-03: a 5% session paid after a switch to 0% was recorded with no fee).
  const applicationFeeCents = Number(metadata.unstream_application_fee_cents);
  if (
    !paymentIntentId || !artistId || !Number.isInteger(amountCents) || !Number.isInteger(grossCents)
    || !Number.isInteger(applicationFeeCents) || applicationFeeCents < 0 || applicationFeeCents > grossCents
  ) {
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

  // Spec §3.3: a signed-in fan's first successful payment marks the artist supported, if they
  // have them saved. Best effort — the payment is recorded either way.
  if (fanUserId) await markSupported(client, fanUserId, artistId);
  return 'recorded';
}

async function markSupported(client: SupabaseClient, userId: string, artistId: string) {
  const { error } = await client
    .from('saved_artists')
    .update({ supported: true, supported_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('artist_id', artistId)
    .eq('supported', false);
  if (error) Sentry.captureMessage('[tips-webhook] mark supported failed', { level: 'warning', extra: { error: error.message } });
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
