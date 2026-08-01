// API endpoint: GET/POST /api/admin/catalog-artist
//
// Admin-only. Catalogs one artist's releases on demand, from a button on their page.
//
// Cataloging is otherwise triggered only by a fan saving an artist or a search resolving one,
// which is deliberate — it's what keeps the crawl small and the page count bounded. This is the
// same escape hatch as `npm run catalog:artist`, reachable without a terminal.
//
// **The internal secret never leaves the server.** The browser authenticates as an admin with
// its ordinary Supabase token; this function holds INTERNAL_FUNCTION_SECRET and uses it to
// invoke the background function. Shipping that secret to the client would hand every visitor
// the ability to make Unstream crawl Bandcamp on demand — the exact amplifier the check-releases
// hardening existed to close.
//
//   GET  ?artistId=…  → is the caller an admin, and what is this artist's catalog state
//   POST { artistId } → clear the cooldown and start a crawl
//
// The GET is what the button uses to decide whether to show itself: visibility follows the
// server's real admin rule rather than a copy of it in page markup.

import { clearCatalogCooldown, getCatalogState } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { triggerCatalogNow } from './request-catalog';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string> | null;
  body?: string;
}) {
  const origin = event.headers['origin'] || event.headers['Origin'];
  const CORS_HEADERS = buildCorsHeaders(origin, false);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization']);
  if (!admin) {
    // 403 for everyone who isn't an admin, including anonymous callers. The button treats any
    // non-200 as "don't show me", so this is also what keeps it invisible to ordinary visitors.
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const artistId = (event.httpMethod === 'GET'
    ? event.queryStringParameters?.artistId
    : safeParseArtistId(event.body)) ?? '';

  if (!UUID_REGEX.test(artistId)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'A valid artistId is required' }),
    };
  }

  if (event.httpMethod === 'GET') {
    const result = await getCatalogState(artistId);
    if (!result.ok) {
      // 503, not a 200 carrying a null state: the caller must be able to tell "we couldn't ask"
      // from "never catalogued", or it will report the second when the first is true.
      return {
        statusCode: 503,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: result.reason }),
      };
    }
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ admin: true, state: result.state }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  await clearCatalogCooldown(artistId);
  const queued = await triggerCatalogNow(artistId);

  if (!queued.ok) {
    return { statusCode: queued.status, headers: CORS_HEADERS, body: JSON.stringify({ error: queued.error }) };
  }

  // Deliberately no `started` flag: the dispatcher's 202 says only that the request was queued,
  // so any boolean derived from it would read as "the crawl was accepted" while being true even
  // when it wasn't. The client polls the GET above, which reports what actually happened.
  return { statusCode: 202, headers: CORS_HEADERS, body: JSON.stringify({ queued: true }) };
}

function safeParseArtistId(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body || '{}') as { artistId?: unknown };
    return typeof parsed.artistId === 'string' ? parsed.artistId : undefined;
  } catch {
    return undefined;
  }
}
