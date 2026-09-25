// API endpoint: /api/open-house
//
// GET — the live half of the Open House page: member count, monthly recurring revenue and a
// per-plan breakdown, aggregated from `memberships`. Costs and closed months come from
// data/open-house/ledger.json instead. Spec: docs/specs/open-house-membership-spec.md §5.
//
// Aggregate only, never per-member: below MIN_PUBLIC_MEMBER_COUNT the counts are withheld so
// one person's payment can't be read off the total.
//
// No Redis. The response is the same for everyone, so the CDN caches it for an hour
// (s-maxage) and a page view costs zero Upstash commands — see "Redis is metered" in
// CLAUDE.md. The page labels these numbers "updated hourly".

import { Sentry } from '../lib/sentry';
import { listLiveMemberships, summariseMemberships } from './membership';

const HEADERS = {
  'Content-Type': 'application/json',
  // Public, anonymous data read by the unstream.stream SPA itself; no credentials involved.
  'Access-Control-Allow-Origin': 'https://unstream.stream',
};

export async function handler(event: { httpMethod: string }) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const summary = summariseMemberships(await listLiveMemberships());
    return {
      statusCode: 200,
      headers: { ...HEADERS, 'Cache-Control': 'public, max-age=300, s-maxage=3600' },
      body: JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }),
    };
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'open-house.live' } });
    // Not cached: a failed read must not sit on the CDN for an hour looking like "no members".
    return {
      statusCode: 503,
      headers: { ...HEADERS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Live figures unavailable' }),
    };
  }
}
