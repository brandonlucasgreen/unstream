// API endpoint: GET/POST /api/admin/flags
// Admin-only endpoint for reading and toggling rudimentary feature flags.
//
// Infrastructure only: adding a flag here does not switch any feature on. Readers ask the store
// (api/functions/feature-flags.ts) and keep their feature admin-only until the flag reads "on".

import { Sentry, withSentry } from '../lib/sentry';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import {
  FEATURE_FLAGS,
  FeatureFlagStoreUnavailableError,
  getFeatureFlags,
  isFeatureFlag,
  setFeatureFlag,
} from './feature-flags';

async function handleRequest({ method, user: admin, body }: SignedInRequest): Promise<EndpointResult> {
  // GET: every known flag and whether it is live to everyone. Answers all-false rather than an
  // error when Redis is down, so the admin page still renders and says what it doesn't know.
  if (method === 'GET') {
    return {
      status: 200,
      body: { flags: await getFeatureFlags() },
    };
  }

  // POST from here on: the wrapper has already refused every other method.
  const { flag, enabled } = body;

  // The registry decides what exists — an unknown name is a client bug, not a new flag.
  if (typeof flag !== 'string' || !isFeatureFlag(flag)) {
    return {
      status: 400,
      body: { error: `flag must be one of: ${FEATURE_FLAGS.join(', ')}` },
    };
  }

  if (typeof enabled !== 'boolean') {
    return {
      status: 400,
      body: { error: 'enabled must be a boolean' },
    };
  }

  try {
    await setFeatureFlag(flag, enabled);
  } catch (error) {
    // The one failure the admin must see: a toggle that did not land must never look like it did.
    if (error instanceof FeatureFlagStoreUnavailableError) {
      return {
        status: 503,
        body: { error: 'Feature flag store is unavailable — the flag was not changed' },
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
    status: 200,
    body: { flags: await getFeatureFlags() },
  };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST'],
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
