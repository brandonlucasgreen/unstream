// Netlify Background Function: write a search's artists and links to Supabase.
//
// Search hands its results here (request-persist.ts) instead of awaiting the writes before it
// responds, so a fan sees results without waiting on the database. Netlify answers the caller
// with 202 as soon as it accepts the invocation and discards whatever this returns.
//
// Reachable only with INTERNAL_FUNCTION_SECRET. It writes rows that become public artist pages,
// so an open endpoint would let anyone mint them — the same reason every hop of the removed
// Discord bot needed auth.

import { withSentry } from '../lib/sentry';
import { persistSearchResults } from './db';
import { parsePersistPayload } from './request-persist';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

async function handleRequest({ body }: PublicRequest): Promise<EndpointResult> {
  const results = parsePersistPayload(body);
  if (!results) return { status: 400 };

  await persistSearchResults(results);
  return { status: 200, body: { persisted: results.length } };
}

export const handler = withSentry(endpoint({
  cors: 'none',
  methods: ['POST'],
  auth: 'internal',
  jsonBody: true,
}, handleRequest));
