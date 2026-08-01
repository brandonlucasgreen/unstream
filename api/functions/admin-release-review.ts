// API endpoint: GET/POST /api/admin/release-review
//
// Admin-only endpoint for the tier-3 dedup backstop (spec §4, §11): ingest never auto-merges a
// fuzzy title match, it only flags both sides via `needs_review` and asks a human. This is
// where that human answers — "these are different" (dismiss) or "these are the same" (merge).

import { getClient, getReleaseReviewQueue, dismissReleaseReview, mergeReleases } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  const origin = event.headers['origin'] || event.headers['Origin'];
  const CORS_HEADERS = buildCorsHeaders(origin, false);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization'] || undefined);
  if (!admin) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const client = getClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Database not configured' }),
    };
  }

  if (event.httpMethod === 'GET') {
    const pairs = await getReleaseReviewQueue();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ pairs }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body: {
    action?: 'dismiss' | 'merge';
    releaseId?: string;
    keepId?: string;
    dropId?: string;
  };

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const { action } = body;

  if (!action || !['dismiss', 'merge'].includes(action)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'action must be "dismiss" or "merge"' }),
    };
  }

  if (action === 'dismiss') {
    const { releaseId } = body;
    if (!releaseId || !UUID_REGEX.test(releaseId)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'releaseId must be a UUID' }),
      };
    }

    const ok = await dismissReleaseReview(releaseId);
    if (!ok) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to dismiss review flag' }),
      };
    }

    Sentry.captureMessage('Release review: dismissed', {
      level: 'info',
      extra: { releaseId, adminId: admin.userId },
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, action }),
    };
  }

  // merge
  const { keepId, dropId } = body;
  if (!keepId || !UUID_REGEX.test(keepId) || !dropId || !UUID_REGEX.test(dropId)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'keepId and dropId must both be UUIDs' }),
    };
  }

  const result = await mergeReleases(keepId, dropId);
  if (!result.ok) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: result.error || 'Failed to merge releases' }),
    };
  }

  Sentry.captureMessage('Release review: merged', {
    level: 'info',
    extra: { keepId, dropId, adminId: admin.userId },
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, action, keepId }),
  };
}
