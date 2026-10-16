// API endpoint: GET/POST /api/admin/flags
// Admin-only endpoint for reading and toggling rudimentary feature flags.
//
// Infrastructure only: adding a flag here does not switch any feature on. Readers ask the store
// (api/functions/feature-flags.ts) and keep their feature admin-only until the flag reads "on".

import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry, withSentry } from '../lib/sentry';
import {
  FEATURE_FLAGS,
  FeatureFlagStoreUnavailableError,
  getFeatureFlags,
  isFeatureFlag,
  setFeatureFlag,
} from './feature-flags';

async function handleRequest(event: {
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

  // GET: every known flag and whether it is live to everyone. Answers all-false rather than an
  // error when Redis is down, so the admin page still renders and says what it doesn't know.
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ flags: await getFeatureFlags() }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body: { flag?: unknown; enabled?: unknown };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const { flag, enabled } = body;

  // The registry decides what exists — an unknown name is a client bug, not a new flag.
  if (typeof flag !== 'string' || !isFeatureFlag(flag)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `flag must be one of: ${FEATURE_FLAGS.join(', ')}` }),
    };
  }

  if (typeof enabled !== 'boolean') {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'enabled must be a boolean' }),
    };
  }

  try {
    await setFeatureFlag(flag, enabled);
  } catch (error) {
    // The one failure the admin must see: a toggle that did not land must never look like it did.
    if (error instanceof FeatureFlagStoreUnavailableError) {
      return {
        statusCode: 503,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Feature flag store is unavailable — the flag was not changed' }),
      };
    }
    throw error;
  }

  // Flipping a flag changes what everyone sees, so it is worth a record of who did it.
  Sentry.captureMessage('Feature flag changed', {
    level: 'info',
    extra: { flag, enabled, adminId: admin.userId },
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ flags: await getFeatureFlags() }),
  };
}

export const handler = withSentry(handleRequest);
