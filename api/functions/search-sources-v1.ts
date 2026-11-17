// V1 API: /api/v1/search
// The same search as /api/search/sources, behind what every v1 endpoint has: an optional API
// key, the key's own quota and its headers, a request ID and the response envelope. The wrapper
// supplies all of those (`auth: 'apiKey'`, `envelope: 'v1'`).

import { withSentry } from '../lib/sentry';
import { endpoint } from './http/endpoint';
import { searchSources } from './search-sources';

export const handler = withSentry(endpoint({
  cors: 'siteOrApiKey',
  methods: ['GET'],
  auth: 'apiKey',
  envelope: 'v1',
  jsonBody: false,
}, async ({ query, apiKey }) => {
  // The search itself, called directly: its own endpoint's rate limit is not this caller's.
  // mode passes through untouched; the search treats anything but 'exact' as fuzzy.
  const result = await searchSources({ query: query.query, ...(query.mode ? { mode: query.mode } : {}) });
  const data = result.body as Record<string, unknown>;

  // Bios and Commons photos aren't part of the v1 contract yet. Wikipedia text and most
  // Commons photos are CC BY-SA, and passing them to API consumers is a licensing decision to
  // document in openapi.yaml on purpose, not a side effect of the app's search response
  // growing a field.
  if (Array.isArray(data.results)) {
    for (const item of data.results as Record<string, unknown>[]) {
      delete item.bio;
      delete item.bioSuppressed;
      delete item.commonsPhoto;
    }
  }

  if (result.status !== 200) return { status: result.status, body: data };

  return {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': apiKey ? 's-maxage=14400, stale-while-revalidate=3600' : 's-maxage=1800, stale-while-revalidate=300',
    },
    body: data,
  };
}));
