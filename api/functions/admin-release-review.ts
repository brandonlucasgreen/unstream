// API endpoint: GET/POST /api/admin/release-review
//
// Admin-only endpoint for the tier-3 dedup backstop (spec §4, §11): ingest never auto-merges a
// fuzzy title match, it only flags both sides via `needs_review` and asks a human. This is
// where that human answers — "these are different" (dismiss) or "these are the same" (merge).

import { getClient, getReleaseReviewQueue, dismissReleaseReview, mergeReleases } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { purgeArtistReleaseCaches } from './purge-cache';
import { Sentry, withSentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleRequest({ method, user: admin, body: parsedBody }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return {
      status: 500,
      body: { error: 'Database not configured' },
    };
  }

  if (method === 'GET') {
    const pairs = await getReleaseReviewQueue();
    return {
      status: 200,
      body: { pairs },
    };
  }

  // POST from here on: the wrapper has already refused every other method.
  const body = parsedBody as {
    action?: 'dismiss' | 'merge';
    releaseId?: string;
    keepId?: string;
    dropId?: string;
  };

  const { action } = body;

  if (!action || !['dismiss', 'merge'].includes(action)) {
    return {
      status: 400,
      body: { error: 'action must be "dismiss" or "merge"' },
    };
  }

  if (action === 'dismiss') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return {
        status: 400,
        body: { error: 'releaseId must be a UUID' },
      };
    }

    const ok = await dismissReleaseReview(releaseId);
    if (!ok) {
      return {
        status: 500,
        body: { error: 'Failed to dismiss review flag' },
      };
    }

    Sentry.captureMessage('Release review: dismissed', {
      level: 'info',
      extra: { releaseId, adminId: admin.userId },
    });

    return {
      status: 200,
      body: { success: true, action },
    };
  }

  // merge
  const { keepId, dropId } = body;
  if (!keepId || !UUID_REGEX.test(keepId) || !dropId || !UUID_REGEX.test(dropId)) {
    return {
      status: 400,
      body: { error: 'keepId and dropId must both be UUIDs' },
    };
  }

  const result = await mergeReleases(keepId, dropId);
  if (!result.ok) {
    return {
      status: 409,
      body: { error: result.error || 'Failed to merge releases' },
    };
  }

  Sentry.captureMessage('Release review: merged', {
    level: 'info',
    extra: { keepId, dropId, adminId: admin.userId },
  });

  // Release pages are CDN-cached for an hour, so a merge would otherwise stay invisible to the
  // public for that long. The artist endpoint purges via its shared `purgeArtistCaches`; this
  // path had no purge at all, which was self-healing only while the TTL was five minutes.
  // One extra read on a rare admin action, resolved from the surviving release.
  const { data: merged } = await client
    .from('releases')
    .select('artists ( slug )')
    .eq('id', keepId)
    .maybeSingle();

  const mergedSlug = (merged as { artists?: { slug?: string } } | null)?.artists?.slug;
  if (mergedSlug) await purgeArtistReleaseCaches(mergedSlug);

  return {
    status: 200,
    body: { success: true, action, keepId },
  };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST'],
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
