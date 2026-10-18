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
import { isInternalRequest } from './middleware';
import { parsePersistPayload } from './request-persist';

async function handleRequest(event: {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: '' };
  }

  if (!isInternalRequest(event.headers?.authorization ?? event.headers?.Authorization)) {
    return { statusCode: 401, body: '' };
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: '' };
  }

  const results = parsePersistPayload(body);
  if (!results) return { statusCode: 400, body: '' };

  await persistSearchResults(results);
  return { statusCode: 200, body: JSON.stringify({ persisted: results.length }) };
}

export const handler = withSentry(handleRequest);
