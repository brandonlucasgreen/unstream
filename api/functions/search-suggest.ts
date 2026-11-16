// GET /api/suggest?query=<partial name>
//
// Typeahead suggestions for the search bar. Reads only the local artists table
// (every artist Unstream has ever resolved), so it answers in one DB read —
// no platform fan-out, no external requests. The full search still happens on
// submit; this only helps people find the right name faster.

import { withSentry } from '../lib/sentry';
import { cacheGetOrFetch, artistCacheKey } from './cache';
import { suggestArtists, cleanSuggestTerm, type ArtistSuggestion } from './db';
import { validateQuery } from './middleware';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

const SUGGEST_CACHE_TTL = 5 * 60; // seconds; the artists table changes slowly

async function handleRequest({ query: params }: PublicRequest): Promise<EndpointResult> {
  const queryResult = validateQuery(params.query);
  if ('error' in queryResult) {
    return { status: 400, body: { error: queryResult.error } };
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
    status: 200,
    body: { query, suggestions },
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate' },
  };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  // 'lenient' tier: the debounced typeahead fires on every typing pause, so it
  // must not share the 30/min 'standard' bucket with account/settings actions —
  // an actively-searching user would 429 themselves out of unrelated endpoints.
  rateLimit: 'lenient',
  jsonBody: false,
}, handleRequest));
