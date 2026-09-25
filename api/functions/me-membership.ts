// API endpoint: /api/me/membership
//
// GET — the signed-in user's Open Studio membership: { active, plan, status, currentPeriodEnd }.
// Used by /open-studio (to hide the ask from members and offer "manage"), /settings, and later
// the badge. Spec: docs/specs/open-studio-membership-spec.md §8.
//
// Follows the other me-* endpoints: bearer auth resolved once by resolveAccountRequest,
// hand-rolled permissive CORS, service-role read. In api/tsconfig.json's typecheck include —
// keep it there.

import { Sentry } from '../lib/sentry';
import { getMembership, isMembershipActive } from './membership';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(statusCode: number, body: unknown) {
  // Per-user answer: never cache it anywhere shared.
  return { statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) };
}

export async function handler(event: { httpMethod: string; headers: Record<string, string | undefined> }) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;
  if (!user) return json(401, { error: 'Not signed in' });

  try {
    const row = await getMembership(user.userId);
    return json(200, {
      active: isMembershipActive(row),
      plan: row?.plan ?? null,
      status: row?.status ?? null,
      currentPeriodEnd: row?.current_period_end ?? null,
      // Whether the Customer Portal has anything to manage: grandfathered rows have no Stripe
      // customer behind them.
      canManage: Boolean(row?.stripe_customer_id),
    });
  } catch (error) {
    // A failed read is not "not a member" — say so, rather than showing a member the ask.
    Sentry.captureException(error, { extra: { context: 'me-membership.get' } });
    return json(503, { error: 'Could not read membership' });
  }
}
