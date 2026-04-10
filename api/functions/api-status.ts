// V1 API: /api/v1/status
// Health check endpoint — no authentication required.

import { buildPublicCorsHeaders, generateRequestId, v1Response } from './middleware';

export async function handler(event: { httpMethod: string; headers?: Record<string, string | undefined> }) {
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