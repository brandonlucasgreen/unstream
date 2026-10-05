// GET /api/search/stored?query=<artist name>
//
// The claimed and verified artists Unstream already holds for a query, and nothing
// else: database reads only, no platform fan-out, no external requests. The web
// client calls this alongside /api/search/sources so an artist we know can be shown
// in a few hundred milliseconds instead of after the slowest platform answers. The
// full search folds the same cards (same ids) into its results, so they replace
// these in place.

import { withSentry } from '../lib/sentry';
import { findStoredArtists } from './stored-artists';
import { checkRateLimit, getClientIp } from './ratelimit';
import { validateQuery, buildPublicCorsHeaders } from './middleware';
import { normalizeSearchQuery } from './search-utils';
import { SearchTimer } from './search-timing';

async function handleRequest(event: { queryStringParameters?: Record<string, string>; headers?: Record<string, string> }) {
  const timer = new SearchTimer();
  const corsHeaders = buildPublicCorsHeaders();

  // 'lenient', not 'strict': this rides along with a search that already spent a unit of
  // the strict daily quota, and a search must not cost an anonymous caller two.
  const ip = getClientIp(event.headers || {});
  const rl = await timer.time('ratelimit', checkRateLimit(ip, 'lenient', corsHeaders));
  if (rl.limited && rl.response) return rl.response;

  const queryResult = validateQuery(event.queryStringParameters?.query);
  if ('error' in queryResult) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: queryResult.error }),
    };
  }
  const query = queryResult.query;

  // Fuzzy only: the web search box is the one caller, and a human typed this query.
  const results = await timer.time('stored', findStoredArtists(normalizeSearchQuery(query), 'fuzzy'));

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      // Short: a claimed artist's profile edit should reach this preview about as soon as
      // it reaches the full search.
      'Cache-Control': 'public, max-age=60, s-maxage=60',
      'Server-Timing': timer.toServerTiming(),
    },
    body: JSON.stringify({ query, results }),
  };
}

export const handler = withSentry(handleRequest);
