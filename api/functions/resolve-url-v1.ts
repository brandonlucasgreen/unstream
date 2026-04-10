// V1 API: /api/v1/resolve
// Thin wrapper around resolve-url that adds API key auth,
// rate limit headers, request IDs, and standardized response envelope.

import { authenticateApiKey, buildCorsHeaders, generateRequestId, v1Response } from './middleware';
import { checkApiRateLimit, getClientIp } from './ratelimit';
import { handler as coreResolveHandler } from './resolve-url';

interface NetlifyEvent {
  httpMethod: string;
  queryStringParameters?: Record<string, string>;
  headers: Record<string, string | undefined>;
  body?: string;
}

export async function handler(event: NetlifyEvent) {
  const requestId = generateRequestId();
  const origin = event.headers.origin || event.headers.Origin;
  const apiKeyHeader = event.headers['x-api-key'] || event.headers['X-API-Key'];
  const apiKeyInfo = await authenticateApiKey(apiKeyHeader);
  const corsHeaders = buildCorsHeaders(origin, !!apiKeyInfo);

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify(v1Response({ error: 'Method not allowed. Use GET.' }, requestId)),
    };
  }

  // Rate limit check
  const identifier = apiKeyInfo ? `rl:api:${apiKeyInfo.keyPrefix}` : getClientIp(event.headers);
  const rl = await checkApiRateLimit(apiKeyInfo, identifier, corsHeaders);
  if (rl.limited) return rl.response;

  const rateLimitHeaders: Record<string, string> = {};
  if (rl.rateLimitInfo) {
    rateLimitHeaders['X-RateLimit-Limit'] = String(rl.rateLimitInfo.limit);
    rateLimitHeaders['X-RateLimit-Remaining'] = String(rl.rateLimitInfo.remaining);
    rateLimitHeaders['X-RateLimit-Reset'] = String(rl.rateLimitInfo.reset);
  }

  // Call the original resolve-url handler.
  // Pass x-internal-skip-ratelimit to prevent double rate limiting (v1 wrapper already checked).
  const coreResult = await coreResolveHandler({
    queryStringParameters: event.queryStringParameters,
    headers: { ...event.headers, 'x-internal-skip-ratelimit': '1' } as Record<string, string>,
  });

  if (!coreResult) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
      body: JSON.stringify(v1Response({ error: 'Internal server error' }, requestId)),
    };
  }

  // Parse the response and wrap in v1 envelope
  try {
    const data = JSON.parse(coreResult.body);

    if (coreResult.statusCode !== 200) {
      return {
        statusCode: coreResult.statusCode,
        headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
        body: JSON.stringify(v1Response(data, requestId)),
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        ...rateLimitHeaders,
        'X-Request-Id': requestId,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': apiKeyInfo ? 's-maxage=14400, stale-while-revalidate=3600' : 's-maxage=1800, stale-while-revalidate=300',
      },
      body: JSON.stringify(v1Response(data, requestId, rl.rateLimitInfo)),
    };
  } catch {
    return {
      statusCode: coreResult.statusCode,
      headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
      body: coreResult.body,
    };
  }
}