// API endpoint: /api/artist?slug=artist-name
// Looks up an artist from the Supabase database.
// Returns the artist with all links, or 404 if not found.

import { getArtistBySlug, resolveArtistSlugAlias } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'standard', corsHeaders);
  if (rl.limited) return rl.response;

  const slug = event.queryStringParameters?.slug;

  if (!slug) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'slug parameter is required' }),
    };
  }

  try {
    let artist = await getArtistBySlug(slug);

    // Only on a miss, and only here: a live slug always wins, and getArtistBySlug is on the search
    // hot path so it must not pay for this. An alias means the artist was merged into another row or
    // re-slugged when accent folding was fixed — either way the old URL should still work.
    if (!artist) {
      const canonical = await resolveArtistSlugAlias(slug);
      if (canonical) artist = await getArtistBySlug(canonical);
    }

    if (!artist) {
      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Artist not found' }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 's-maxage=60, stale-while-revalidate=60',
        'Cache-Tag': `artist-${slug}`,
      },
      body: JSON.stringify(artist),
    };
  } catch (error) {
    console.error('[artist-lookup] Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
