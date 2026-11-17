// POST /api/analytics/event
// Lightweight, public endpoint for recording anonymous artist analytics events.
// Accepts { slug, metric } and atomically increments the daily count.
// Returns 204 on success (or silent no-op on errors).

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';
import { CURATED_PLATFORMS, SEARCH_ONLY_PLATFORMS } from './search-utils';
import { RELEASE_VIEW_PREFIX, STREAMING_METRIC } from './artist-activity';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Build set of valid source IDs for click: metrics from the SourceId union + platform sets
const VALID_SOURCE_IDS = new Set<string>([
  ...CURATED_PLATFORMS,
  ...SEARCH_ONLY_PLATFORMS,
  // Additional valid click sources not in the curated/search-only sets
  'bandcamp', 'qobuz', 'beatport', 'even', 'artcore', 'ampwall',
  'patreon', 'officialsite', 'discogs', 'musicbrainz',
  // Profile-link-only patronage options (UNS-217): a fan clicking a claimed artist's Venmo or
  // PayPal link fires click:<platform> for the artist dashboard; without it here the event is
  // dropped silently at this whitelist. The same goes for the profile-link-only platforms added
  // after them.
  'venmo', 'paypal', 'cashapp', 'steady', 'tipeee', 'bigcartel',
  'spotify', 'apple-music', 'youtube', 'instagram', 'facebook', 'tiktok',
  'threads', 'bluesky', 'mastodon', 'funkwhale',
  'listenbrainz', 'librefm', 'internetarchive',
  // The extension popup's Tip button, a click-out to the artist's own tip page (tips spec §6,
  // UNS-213). Not a third-party platform, but the same shape of event as click:bandcamp — a fan
  // leaving for an artist's page — so it rides this endpoint and the same breakdown on the artist
  // dashboard. Without it here the popup's event is dropped silently at the whitelist.
  'tip',
]);

// Valid metrics (see artist-activity.ts for what each one means): 'search', 'streaming', 'view',
// 'click:{valid_source_id}', and 'release_view:{release id}' — the last checked against the
// artist below, since its id can't be checked against a fixed list.
function isValidMetric(metric: string): boolean {
  if (metric === 'search' || metric === 'view' || metric === STREAMING_METRIC) return true;
  if (metric.startsWith(RELEASE_VIEW_PREFIX)) return UUID_REGEX.test(metric.slice(RELEASE_VIEW_PREFIX.length));
  if (metric.startsWith('click:')) {
    const sourceId = metric.slice(6);
    return VALID_SOURCE_IDS.has(sourceId);
  }
  return false;
}

// Module-level cache: slug → artist_id (persists across warm invocations)
const slugCache = new Map<string, string>();

// `${artistId}:${releaseId}` pairs already confirmed to belong together.
const releaseOwnerCache = new Set<string>();

// More slugs than any real search renders is abuse, not analytics.
const MAX_BATCH_SLUGS = 24;

async function handleRequest({ body }: PublicRequest): Promise<EndpointResult> {
  // Validate. Two body shapes: { slug, metric } — one event, what the extension and
  // Mac app send — and { slugs: [...], metric } — the web app's batched search appearances,
  // one request for every claimed artist a search rendered instead of one request per card.
  const metric = body.metric as string;
  let slugs: string[] = Array.isArray(body.slugs) ? body.slugs : [body.slug];

  slugs = [...new Set(slugs.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 200))]
    .slice(0, MAX_BATCH_SLUGS);

  if (slugs.length === 0 || !metric || !isValidMetric(metric)) {
    return { status: 204 }; // silent no-op
  }

  const client = getClient();
  if (!client) {
    return { status: 204 }; // DB not configured
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
    return { status: 204 };
  }

  // A release view must name one of this artist's releases. Otherwise anyone could write rows
  // that the artist's Analytics page would then go looking up. One artist per release view: the
  // release page sends exactly one.
  if (metric.startsWith(RELEASE_VIEW_PREFIX)) {
    if (ids.length !== 1) return { status: 204 };
    const releaseId = metric.slice(RELEASE_VIEW_PREFIX.length);
    const key = `${ids[0]}:${releaseId}`;
    if (!releaseOwnerCache.has(key)) {
      const { data: release } = await client
        .from('releases')
        .select('id')
        .eq('id', releaseId)
        .eq('artist_id', ids[0])
        .maybeSingle();
      if (!release) return { status: 204 };
      releaseOwnerCache.add(key);
    }
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

  return { status: 204 };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['POST'],
  auth: 'none',
  rateLimit: 'standard',
  jsonBody: true,
}, handleRequest));
