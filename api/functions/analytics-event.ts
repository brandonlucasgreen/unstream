// POST /api/analytics/event
// Lightweight, public endpoint for recording anonymous artist analytics events.
// Accepts { slug, metric } and atomically increments the daily count.
// Returns 204 on success (or silent no-op on errors).

import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Allowlist for metric values: search, view, or click:{platform}
const METRIC_PATTERN = /^(search|view|click:[a-z0-9_-]+)$/;

// Module-level cache: slug → artist_id (persists across warm invocations)
const slugCache = new Map<string, string>();

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: '{"error":"Method not allowed"}' };
  }

  // Rate limit
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  // Parse and validate
  let slug: string;
  let metric: string;
  try {
    const body = JSON.parse(event.body || '{}');
    slug = body.slug;
    metric = body.metric;
  } catch {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // silent no-op on bad JSON
  }

  if (!slug || !metric || !METRIC_PATTERN.test(metric)) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // silent no-op
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // DB not configured
  }

  // Resolve artist_id from slug (with cache)
  let artistId = slugCache.get(slug);
  if (!artistId) {
    const { data: artist } = await client
      .from('artists')
      .select('id')
      .eq('slug', slug)
      .single();

    if (!artist) {
      return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // unknown artist
    }
    artistId = artist.id;
    slugCache.set(slug, artistId);
  }

  // Atomic upsert-increment
  const today = new Date().toISOString().split('T')[0];
  try {
    await client.rpc('increment_analytics', {
      p_artist_id: artistId,
      p_date: today,
      p_metric: metric,
    });
  } catch {
    // Silent fail — don't break the caller's experience for analytics
  }

  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}
