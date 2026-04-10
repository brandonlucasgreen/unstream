// V1 API: /api/v1/artist/{slug}
// Thin wrapper around artist-lookup that adds API key auth,
// rate limit headers, request IDs, and standardized response envelope.

import { authenticateApiKey, buildCorsHeaders, generateRequestId, v1Response } from './middleware';
import { checkApiRateLimit, getClientIp } from './ratelimit';
import { getArtistBySlug } from './db';

interface NetlifyEvent {
  httpMethod: string;
  queryStringParameters?: Record<string, string>;
  path?: string;
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

  // Extract slug from path or query string
  // Netlify redirect-based routes pass the full path; extract slug from /api/v1/artist/{slug}
  let slug: string | undefined;
  if (event.path) {
    const match = event.path.match(/\/api\/v1\/artist\/([^/]+)$/);
    if (match) slug = decodeURIComponent(match[1]);
  }
  if (!slug) slug = event.queryStringParameters?.slug;

  if (!slug) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
      body: JSON.stringify(v1Response({ error: 'Artist slug is required. Use /api/v1/artist/{slug}' }, requestId)),
    };
  }

  try {
    const artist = await getArtistBySlug(slug);

    if (!artist) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
        body: JSON.stringify(v1Response({ error: 'Artist not found' }, requestId)),
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
        'Cache-Tag': `artist-${slug}`,
      },
      body: JSON.stringify(v1Response(artist, requestId, rl.rateLimitInfo)),
    };
  } catch (error) {
    console.error('[artist-lookup-v1] Error:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, ...rateLimitHeaders, 'X-Request-Id': requestId },
      body: JSON.stringify(v1Response({ error: 'Internal server error' }, requestId)),
    };
  }
}