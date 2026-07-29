// GET /api/suggest?query=<partial name>
//
// Typeahead suggestions for the search bar. Reads only the local artists table
// (every artist Unstream has ever resolved), so it answers in one DB read —
// no platform fan-out, no external requests. The full search still happens on
// submit; this only helps people find the right name faster.

import { cacheGetOrFetch, artistCacheKey } from './cache';
import { suggestArtists, cleanSuggestTerm, type ArtistSuggestion } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { validateQuery, buildPublicCorsHeaders } from './middleware';

const SUGGEST_CACHE_TTL = 5 * 60; // seconds; the artists table changes slowly

export async function handler(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const corsHeaders = buildPublicCorsHeaders();

  // 'lenient' tier: the debounced typeahead fires on every typing pause, so it
  // must not share the 30/min 'standard' bucket with account/settings actions —
  // an actively-searching user would 429 themselves out of unrelated endpoints.
  const ip = getClientIp(event.headers || {});
  const rl = await checkRateLimit(ip, 'lenient', corsHeaders);
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

  // The cache key and the DB query must be derived from the SAME string:
  // keying on a more aggressively normalized form collides inputs that produce
  // different ILIKE patterns ("sufjan-stevens" vs "sufjan stevens"), serving
  // whichever variant was queried first to all the others for the TTL.
  const cleaned = cleanSuggestTerm(query);

  // Below two characters a suggestion list is noise; an empty 200 (not a 400)
  // keeps the client logic trivial while someone is mid-keystroke.
  let suggestions: ArtistSuggestion[] = [];
  if (cleaned.length >= 2) {
    const cacheKey = artistCacheKey('suggest', cleaned);
    const { data } = await cacheGetOrFetch<ArtistSuggestion[] | null>(
      cacheKey,
      () => suggestArtists(cleaned),
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
