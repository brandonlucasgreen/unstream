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
// The button shows itself only to the admin, which is presentation; what refuses everyone else
// is this function, on both methods.

import { withSentry } from '../lib/sentry';
import { clearCatalogCooldown, clearReleaseDetailCooldown, getCatalogState } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { triggerCatalogNow } from './request-catalog';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleRequest({ method, query, body }: SignedInRequest): Promise<EndpointResult> {
  const requested = method === 'GET' ? query.artistId : body.artistId;
  const artistId = typeof requested === 'string' ? requested : '';

  if (!UUID_REGEX.test(artistId)) {
    return { status: 400, body: { error: 'A valid artistId is required' } };
  }

  if (method === 'GET') {
    const result = await getCatalogState(artistId);
    if (!result.ok) {
      // 503, not a 200 carrying a null state: the caller must be able to tell "we couldn't ask"
      // from "never catalogued", or it will report the second when the first is true.
      return { status: 503, body: { error: result.reason } };
    }
    return { status: 200, body: { admin: true, state: result.state } };
  }

  // POST from here on: the wrapper has already refused every other method.

  // Both, always: the cooldown lets the crawl run, and the detail reset is what makes it
  // re-read prices rather than only re-confirming the release list. See db.ts.
  await clearCatalogCooldown(artistId);
  await clearReleaseDetailCooldown(artistId);
  const queued = await triggerCatalogNow(artistId);

  if (!queued.ok) {
    return { status: queued.status, body: { error: queued.error } };
  }

  // Deliberately no `started` flag: the dispatcher's 202 says only that the request was queued,
  // so any boolean derived from it would read as "the crawl was accepted" while being true even
  // when it wasn't. The client polls the GET above, which reports what actually happened.
  return { status: 202, body: { queued: true } };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST'],
  // Anyone who isn't the admin, anonymous callers included, gets a 401. The button reads any
  // non-200 the same way, as no catalog state to show.
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
