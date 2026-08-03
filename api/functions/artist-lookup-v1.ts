// V1 API: /api/v1/artist/{slug}
// Thin wrapper around artist-lookup that adds API key auth,
// rate limit headers, request IDs, and standardized response envelope.

import { authenticateApiKey, buildCorsHeaders, generateRequestId, v1Response } from './middleware';
import { checkApiRateLimit, getClientIp } from './ratelimit';
import { getArtistBySlug, resolveArtistSlugAlias } from './db';

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

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify(v1Response({ error: 'Method not allowed. Use GET.' }, requestId)),
    };
  }

  // Rate limit check
  const identifier = getClientIp(event.headers);
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
    let artist = await getArtistBySlug(slug);

    // A retired slug (merge loser, or an accent re-slug) still resolves. Third-party integrations
    // hold onto these, so silently 404ing one would break their stored links.
    if (!artist) {
      const canonical = await resolveArtistSlugAlias(slug);
      if (canonical) artist = await getArtistBySlug(canonical);
    }

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