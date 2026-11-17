// V1 API: /api/v1/resolve
// The same lookup as /api/resolve-url, behind what every v1 endpoint has: an optional API key,
// the key's own quota and its headers, a request ID and the response envelope. The wrapper
// supplies all of those (`auth: 'apiKey'`, `envelope: 'v1'`).

import { withSentry } from '../lib/sentry';
import { endpoint } from './http/endpoint';
import { resolveUrl } from './resolve-url';

export const handler = withSentry(endpoint({
  cors: 'siteOrApiKey',
  methods: ['GET'],
  auth: 'apiKey',
  envelope: 'v1',
  jsonBody: false,
}, async ({ query, apiKey }) => {
  // The lookup itself, called directly: its own endpoint's rate limit is not this caller's.
  const result = await resolveUrl(query);
  if (result.status !== 200) return { status: result.status, body: result.body };

  return {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': apiKey ? 's-maxage=14400, stale-while-revalidate=3600' : 's-maxage=1800, stale-while-revalidate=300',
    },
    body: result.body,
  };
}));
