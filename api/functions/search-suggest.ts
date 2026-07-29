// GET /api/suggest?query=<partial name>
//
// Typeahead suggestions for the search bar. Reads only the local artists table
// (every artist Unstream has ever resolved), so it answers in one DB read —
// no platform fan-out, no external requests. The full search still happens on
// submit; this only helps people find the right name faster.

import { cacheGetOrFetch } from './cache';
import { suggestArtists, type ArtistSuggestion } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { validateQuery } from './middleware';
import { normalizeForComparison } from './search-utils';

const SUGGEST_CACHE_TTL = 5 * 60; // seconds; the artists table changes slowly

export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'standard', corsHeaders);
  if (rl.limited) return rl.response;

  const queryResult = validateQuery(event.queryStringParameters?.query);
  if ('error' in queryResult) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: queryResult.error }),
    };
  }
  const query = queryResult.query;

  // Below two characters a suggestion list is noise; an empty 200 (not a 400)
  // keeps the client logic trivial while someone is mid-keystroke.
  let suggestions: ArtistSuggestion[] = [];
  if (query.trim().length >= 2) {
    const cacheKey = `suggest:${normalizeForComparison(query)}`;
    const { data } = await cacheGetOrFetch<ArtistSuggestion[] | null>(
      cacheKey,
      () => suggestArtists(query),
      SUGGEST_CACHE_TTL,
      // null means the DB couldn't be asked — a failure, not "no suggestions".
      (data) => data !== null,
    );
    suggestions = data ?? [];
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate',
    },
    body: JSON.stringify({ query, suggestions }),
  };
}
