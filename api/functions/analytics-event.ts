// POST /api/analytics/event
// Lightweight, public endpoint for recording anonymous artist analytics events.
// Accepts { slug, metric } and atomically increments the daily count.
// Returns 204 on success (or silent no-op on errors).

import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { CURATED_PLATFORMS, SEARCH_ONLY_PLATFORMS } from './search-utils';

// Build set of valid source IDs for click: metrics from the SourceId union + platform sets
const VALID_SOURCE_IDS = new Set<string>([
  ...CURATED_PLATFORMS,
  ...SEARCH_ONLY_PLATFORMS,
  // Additional valid click sources not in the curated/search-only sets
  'bandcamp', 'qobuz', 'beatport', 'even', 'nina', 'artcore', 'ampwall',
  'patreon', 'officialsite', 'discogs', 'musicbrainz',
  'spotify', 'apple-music', 'youtube', 'instagram', 'facebook', 'tiktok',
  'threads', 'bluesky', 'mastodon', 'funkwhale',
  'listenbrainz', 'librefm', 'internetarchive',
]);

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Validate metric values: must be 'search', 'view', or 'click:{valid_source_id}'
function isValidMetric(metric: string): boolean {
  if (metric === 'search' || metric === 'view') return true;
  if (metric.startsWith('click:')) {
    const sourceId = metric.slice(6);
    return VALID_SOURCE_IDS.has(sourceId);
  }
  return false;
}

// Module-level cache: slug → artist_id (persists across warm invocations)
const slugCache = new Map<string, string>();

// More slugs than any real search renders is abuse, not analytics.
const MAX_BATCH_SLUGS = 24;

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

  // Parse and validate. Two body shapes: { slug, metric } — one event, what the extension and
  // Mac app send — and { slugs: [...], metric } — the web app's batched search appearances,
  // one request for every claimed artist a search rendered instead of one request per card.
  let slugs: string[];
  let metric: string;
  try {
    const body = JSON.parse(event.body || '{}');
    metric = body.metric;
    slugs = Array.isArray(body.slugs) ? body.slugs : [body.slug];
  } catch {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // silent no-op on bad JSON
  }

  slugs = [...new Set(slugs.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 200))]
    .slice(0, MAX_BATCH_SLUGS);

  if (slugs.length === 0 || !metric || !isValidMetric(metric)) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // silent no-op
  }

  const client = getClient();
  if (!client) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }; // DB not configured
  }

  // Resolve artist ids from slugs — cache first, then one query for whatever's left
  const ids: string[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const cached = slugCache.get(slug);
    if (cached) ids.push(cached);
    else missing.push(slug);
  }
  if (missing.length > 0) {
    const { data: artists } = await client
      .from('artists')
      .select('id, slug')
      .in('slug', missing);
    for (const artist of (artists as Array<{ id: string; slug: string }>) ?? []) {
      slugCache.set(artist.slug, artist.id);
      ids.push(artist.id);
    }
    // Unknown slugs are dropped silently, same as the single-event path always has.
  }

  if (ids.length === 0) {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Atomic upsert-increment: the single-row RPC for one event, the batch RPC for many —
  // one transaction either way.
  const today = new Date().toISOString().split('T')[0];
  try {
    if (ids.length === 1) {
      await client.rpc('increment_analytics', {
        p_artist_id: ids[0],
        p_date: today,
        p_metric: metric,
      });
    } else {
      await client.rpc('increment_analytics_batch', {
        p_artist_ids: ids,
        p_date: today,
        p_metric: metric,
      });
    }
  } catch {
    // Silent fail — don't break the caller's experience for analytics
  }

  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}
