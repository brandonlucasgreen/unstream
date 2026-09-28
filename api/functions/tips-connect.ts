// API endpoint: POST /api/tips/connect — start or resume Stripe onboarding for a claimed artist
// (docs/specs/artist-patronage-spec.md §4, §6, §8).
//
// Body: { slug, country, acceptAddendum: true }
//   country         ISO-2, one Stripe supports. Only read when the account is first created.
//   acceptAddendum  the artist addendum checkbox; required when the account is first created.
// Returns { url } — a Stripe-hosted Account Link. The artist completes onboarding on Stripe and
// comes back to /dashboard; account.updated (tips-webhook) and tips-settings GET both sync the
// account's state.
//
// The account is Standard with Stripe as the controller of fees, losses and requirement
// collection: the artist is the merchant of record, pays Stripe's fees, owns refunds and disputes
// in their own Stripe dashboard, and Stripe carries fraud losses. Nothing here moves money.

import { getClient, resolveOwnedArtist } from './db';
import { authenticateBearer } from './middleware';
import { checkRateLimit, getClientIp } from './ratelimit';
import { isLiveMode, stripeMode, stripeRequest, StripeError, type StripeAccount, type StripeAccountLink } from './stripe';
import { getTipAccount } from './tips-db';
import { siteUrl, TIPS_CORS_HEADERS as CORS_HEADERS, respond } from './tips-http';
import { ARTIST_ADDENDUM_VERSION, isStripeConnectCountry } from '../shared/tips';
import { Sentry } from '../lib/sentry';

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}

export async function handler(event: HandlerEvent) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  // The full auth-server check, not the fast local one: this links a payout account to a profile.
  const user = await authenticateBearer(event.headers.authorization);
  const rl = await checkRateLimit(user ? `user:${user.userId}` : `ip:${getClientIp(event.headers)}`, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response!;
  if (!user) return respond(401, { error: 'Not authenticated' });

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

    // A different owner's account on this profile (the profile changed hands) is never reused:
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

      // Idempotent per artist and mode, so a double-click can't create two Stripe accounts.
      const created = await stripeRequest<StripeAccount>('POST', '/v1/accounts', {
        country,
        controller: {
          stripe_dashboard: { type: 'full' },
          fees: { payer: 'account' },
          losses: { payments: 'stripe' },
          requirement_collection: 'stripe',
        },
        business_profile: { product_description: `Tips for ${owned.artistName}'s music, through Unstream` },
        metadata: { unstream_artist_id: artistId },
      }, { idempotencyKey: `connect:${artistId}:${stripeMode()}` });

      const now = new Date().toISOString();
      const { data, error } = await client.from('artist_tip_accounts').insert({
        artist_id: artistId,
        livemode: isLiveMode(),
        stripe_account_id: created.id,
        user_id: user.userId,
        charges_enabled: created.charges_enabled ?? false,
        details_submitted: created.details_submitted ?? false,
        country: created.country ?? country,
        addendum_accepted_at: now,
        addendum_version: ARTIST_ADDENDUM_VERSION,
      }).select('*').single();
      if (error) throw new Error(`artist_tip_accounts insert failed: ${error.message}`);
      account = data as typeof account;
    }

    const link = await stripeRequest<StripeAccountLink>('POST', '/v1/account_links', {
      account: account!.stripe_account_id,
      type: 'account_onboarding',
      refresh_url: `${siteUrl()}/dashboard?tips=refresh&slug=${encodeURIComponent(slug)}`,
      return_url: `${siteUrl()}/dashboard?tips=return&slug=${encodeURIComponent(slug)}`,
    });
    return respond(200, { url: link.url });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: 'tips-connect', stripeCode: err instanceof StripeError ? err.code : undefined } });
    return respond(502, { error: "Couldn't reach Stripe. Try again in a moment." });
  }
}
