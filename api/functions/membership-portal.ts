// API endpoint: /api/membership/portal
//
// POST — creates a Stripe Customer Portal session for the signed-in member and returns
// { url }. The portal is where members cancel, change plan or update a card; Unstream builds
// none of that itself. Spec: docs/specs/open-studio-membership-spec.md §4.

import { Sentry } from '../lib/sentry';
import { getMembership } from './membership';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';
import { getStripe, siteUrl } from './stripe-client';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) };
}

export async function handler(event: { httpMethod: string; headers: Record<string, string | undefined> }) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;
  if (!user) return json(401, { error: 'Not signed in' });

  const stripe = getStripe();
  if (!stripe) {
    Sentry.captureMessage('membership-portal: STRIPE_SECRET_KEY not configured', 'error');
    return json(503, { error: 'Membership isn’t available right now' });
  }

  try {
    const row = await getMembership(user.userId);
    // Grandfathered members have no Stripe customer, so there's nothing to manage.
    if (!row?.stripe_customer_id) return json(404, { error: 'No membership to manage' });

    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${siteUrl()}/open-studio`,
    });
    return json(200, { url: session.url });
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'membership-portal.create' } });
    return json(502, { error: 'Could not open membership settings' });
  }
}
