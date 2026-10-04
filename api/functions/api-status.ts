// V1 API: /api/v1/status
// Health check endpoint — no authentication required.

import { withSentry } from '../lib/sentry';
import { buildPublicCorsHeaders, generateRequestId, v1Response } from './middleware';

async function handleRequest(event: { httpMethod: string; headers?: Record<string, string | undefined> }) {
  const requestId = generateRequestId();
  const corsHeaders = buildPublicCorsHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'X-Request-Id': requestId,
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(v1Response({
      status: 'ok',
      version: '1',
      timestamp: new Date().toISOString(),
    }, requestId)),
  };
}

export const handler = withSentry(handleRequest);
