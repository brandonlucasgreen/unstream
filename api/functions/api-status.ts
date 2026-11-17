// V1 API: /api/v1/status
// Health check endpoint — no authentication required.

import { withSentry } from '../lib/sentry';
import { endpoint, type EndpointResult } from './http/endpoint';

async function handleRequest(): Promise<EndpointResult> {
  return {
    status: 200,
    body: {
      status: 'ok',
      version: '1',
      timestamp: new Date().toISOString(),
    },
    headers: { 'Cache-Control': 'public, max-age=60' },
  };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'none',
  jsonBody: false,
  envelope: 'v1',
}, handleRequest));
