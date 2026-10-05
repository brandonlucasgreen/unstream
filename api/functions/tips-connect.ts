// API endpoint: POST /api/tips/connect — start or resume Stripe onboarding for a claimed artist
// (docs/specs/artist-patronage-spec.md §4, §6, §8).
//
// Body: { slug, country, acceptAddendum: true }
//   country         ISO-2, one Stripe supports. Only read when an account is created.
//   acceptAddendum  the artist addendum checkbox; required when an account is created.
// An account is created the first time, and again after the artist disconnected Unstream from
// their Stripe dashboard (deauthorized_at): that row is then reused in place for the new account.
// Returns { url } — a Stripe-hosted Account Link. The artist completes onboarding on Stripe and
// comes back to the Manage Tips tab (/artist-edit/:slug/tips); account.updated (tips-webhook) and
// tips-settings GET both sync the account's state.
//
// Errors: Stripe refusing the request (a 4xx) is permanent and answers code 'stripe_rejected' —
// with Stripe's own message for the admin, a pointer to support for anyone else. Anything
// temporary (network, 5xx, 429) asks the artist to try again.
//
// The account is Standard with Stripe as the controller of fees, losses and requirement
// collection: the artist is the merchant of record, pays Stripe's fees, owns refunds and disputes
// in their own Stripe dashboard, and Stripe carries fraud losses. Nothing here moves money.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient, resolveOwnedArtist } from './db';
import { authenticateBearer } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import {
  encodeForm,
  isLiveMode,
  isStripeRejection,
  stripeMode,
  stripeRequest,
  StripeError,
  type FormValue,
  type StripeAccount,
  type StripeAccountLink,
} from './stripe';
import { canSetUpTips, getTipAccount, type TipAccountRow } from './tips-db';
import { siteUrl, TIPS_CORS_HEADERS as CORS_HEADERS, respond } from './tips-http';
import { ARTIST_ADDENDUM_VERSION, isStripeConnectCountry } from '../shared/tips';
import { Sentry, withSentry } from '../lib/sentry';

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}

async function handleRequest(event: HandlerEvent) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  // The full auth-server check, not the fast local one: this links a payout account to a profile.
  const user = await authenticateBearer(event.headers.authorization);
  const rl = await checkRateLimit(user ? `user:${user.userId}` : `ip:${getClientIp(event.headers)}`, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response!;
  if (!user) return respond(401, { error: 'Not authenticated' });
  // Private for now: only the admin can connect a Stripe account (see canSetUpTips).
  if (!canSetUpTips(user.email)) return respond(403, { error: "Tips aren't open to artists yet" });

  if (!stripeMode()) return respond(503, { error: 'Tips are not available yet' });
  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  const slug = typeof body.slug === 'string' ? body.slug : '';

  const owned = await resolveOwnedArtist(slug, user.userId);
  if (!owned.ok) return respond(owned.status, { error: owned.error });
  const artistId = owned.artistId!;

  try {
    let account = await getTipAccount(client, artistId);
    // Disconnected from Stripe's side: as good as no account. The artist starts over.
    const disconnected = account?.deauthorized_at ? account : null;
    if (disconnected) account = null;

    // A different owner's live account on this profile (the profile changed hands) is never reused:
    // onboarding would hand the new owner a link into someone else's Stripe account.
    if (account && account.user_id !== user.userId) {
      return respond(409, { error: 'This profile has a Stripe account connected by a previous owner. Contact support.' });
    }

    if (!account) {
      if (body.acceptAddendum !== true) {
        return respond(400, { error: 'Accept the artist terms to continue' });
      }
      const country = typeof body.country === 'string' ? body.country.toUpperCase() : '';
      if (!isStripeConnectCountry(country)) {
        return respond(400, { error: "Stripe isn't available in that country yet", code: 'unsupported_country' });
      }
      account = await createAccount(client, { artistId, artistName: owned.artistName!, userId: user.userId, country, disconnected });
      if (account.user_id !== user.userId) {
        return respond(409, { error: 'This profile has a Stripe account connected by a previous owner. Contact support.' });
      }
    }

    const link = await stripeRequest<StripeAccountLink>('POST', '/v1/account_links', {
      account: account.stripe_account_id,
      type: 'account_onboarding',
      refresh_url: `${siteUrl()}/artist-edit/${encodeURIComponent(slug)}/tips?stripe=refresh`,
      return_url: `${siteUrl()}/artist-edit/${encodeURIComponent(slug)}/tips?stripe=return`,
    });
    return respond(200, { url: link.url });
  } catch (err) {
    Sentry.captureException(err, {
      extra: { context: 'tips-connect', stripeStatus: err instanceof StripeError ? err.status : undefined, stripeCode: err instanceof StripeError ? err.code : undefined },
    });
    if (isStripeRejection(err)) {
      // Permanent: retrying won't help. Stripe's message is for the admin only — it can name
      // platform settings an artist can't act on.
      return respond(502, {
        error: canSetUpTips(user.email)
          ? `Stripe couldn't set up the account: ${err.message}`
          : "Stripe couldn't set up the account. Contact support@unstream.stream.",
        code: 'stripe_rejected',
      });
    }
    return respond(502, { error: "Couldn't reach Stripe. Try again in a moment." });
  }
}

/**
 * Create the artist's Standard account (Stripe controls fees, losses and requirement collection:
 * the artist is the merchant of record) and record it — a new row, or, after a disconnect, the old
 * row reused in place with everything about the old account reset: approval, Stripe's switches, the
 * artist's own switch, and the addendum accepted again. Approval in particular must never carry
 * over to a different Stripe account (the migration's promise on tips_approved_at).
 *
 * Idempotency: the key is the artist, the mode, which generation of the row this is (a first
 * connect, or a reconnect replacing a specific disconnected account) and a hash of the exact
 * params. A double click sends identical params and gets the same account back; a retry with a
 * different country or a renamed artist is a different request rather than an idempotency_error
 * for the next 24 hours.
 *
 * Two requests racing (a double click that both pass the "no account" read): both get the same
 * Stripe account from the key, one write lands, and the other finds the row on re-reading.
 */
async function createAccount(
  client: SupabaseClient,
  args: { artistId: string; artistName: string; userId: string; country: string; disconnected: TipAccountRow | null },
): Promise<TipAccountRow> {
  const { artistId, artistName, userId, country, disconnected } = args;
  const params: Record<string, FormValue> = {
    country,
    controller: {
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    business_profile: { product_description: `Tips for ${artistName}'s music, through Unstream` },
    metadata: { unstream_artist_id: artistId },
  };
  const generation = disconnected ? `re:${disconnected.stripe_account_id}` : 'new';
  const paramsHash = createHash('sha256').update(encodeForm(params)).digest('hex').slice(0, 16);
  const created = await stripeRequest<StripeAccount>('POST', '/v1/accounts', params, {
    idempotencyKey: `connect:${artistId}:${stripeMode()}:${generation}:${paramsHash}`,
  });

  const fields = {
    stripe_account_id: created.id,
    user_id: userId,
    charges_enabled: created.charges_enabled ?? false,
    details_submitted: created.details_submitted ?? false,
    country: created.country ?? country,
    addendum_accepted_at: new Date().toISOString(),
    addendum_version: ARTIST_ADDENDUM_VERSION,
  };

  if (disconnected) {
    // Conditional on the row still holding the disconnected account, so a racing request that
    // already swapped it in updates nothing here and re-reads below.
    const { data, error } = await client.from('artist_tip_accounts')
      .update({ ...fields, deauthorized_at: null, tips_approved_at: null, tips_enabled: false })
      .eq('artist_id', artistId)
      .eq('livemode', isLiveMode())
      .eq('stripe_account_id', disconnected.stripe_account_id)
      .select('*');
    if (error) throw new Error(`artist_tip_accounts reconnect failed: ${error.message}`);
    const row = (data as TipAccountRow[] | null)?.[0];
    if (row) return row;
  } else {
    const { data, error } = await client.from('artist_tip_accounts').insert({
      artist_id: artistId,
      livemode: isLiveMode(),
      ...fields,
    }).select('*').single();
    if (data) return data as TipAccountRow;
    // 23505: a concurrent request inserted first. Anything else is a real failure.
    if (error?.code !== '23505') throw new Error(`artist_tip_accounts insert failed: ${error?.message}`);
  }

  const current = await getTipAccount(client, artistId);
  if (!current || current.deauthorized_at) throw new Error('artist_tip_accounts row missing after a concurrent connect');
  return current;
}

export const handler = withSentry(handleRequest);
