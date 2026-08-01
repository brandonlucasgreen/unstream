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

import { getClient, type CatalogTrigger } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { Sentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CatalogState {
  last_catalogued_at: string | null;
  last_attempted_at: string;
  releases_found: number | null;
  releases_detailed: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/**
 * Read this artist's catalog state.
 *
 * Deliberately three-valued, not two. "We couldn't ask" and "we asked and this artist has never
 * been catalogued" are different facts, and collapsing them into one `null` makes a broken
 * database read render as a confident "Never catalogued" — the same shape as the bug class the
 * "never cache uncertainty" principle exists to prevent. This whole feature exists to give
 * cataloging an observable surface, so an unreadable one has to say so.
 */
type StateResult =
  | { ok: true; state: CatalogState | null }
  | { ok: false; reason: string };

async function readState(artistId: string): Promise<StateResult> {
  const client = getClient();
  if (!client) return { ok: false, reason: 'Supabase is not configured on this deploy' };

  const { data, error } = await client
    .from('release_catalog_state')
    .select('last_catalogued_at, last_attempted_at, releases_found, releases_detailed, last_error, consecutive_failures')
    .eq('artist_id', artistId)
    .maybeSingle();

  if (error) {
    console.error('[admin-catalog] state read failed:', error.message);
    return { ok: false, reason: 'Could not read catalog state' };
  }
  return { ok: true, state: (data as CatalogState | null) ?? null };
}

/**
 * Clear this artist's cooldown so the crawl actually runs.
 *
 * Without it the button would appear to work and do nothing for a week — `claimArtistForCatalog`
 * refuses an artist catalogued in the last 7 days, which is right for demand-driven triggers and
 * wrong for someone deliberately pressing "catalog now".
 *
 * Backdated rather than deleted: the row also carries the failure counter and the last error,
 * which are worth keeping. Two hours clears both the cooldown and the exponential backoff.
 */
async function clearCooldown(artistId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { error } = await client
    .from('release_catalog_state')
    .update({ last_catalogued_at: null, last_attempted_at: twoHoursAgo, consecutive_failures: 0 })
    .eq('artist_id', artistId);

  if (error) console.error('[admin-catalog] cooldown clear failed:', error.message);
}

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
    const result = await readState(artistId);
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

  // Every reason the background function would refuse, checked here instead — because its
  // answer never comes back. Netlify's dispatcher returns 202 to the caller the instant it
  // accepts a background invocation and discards whatever the handler returns, so a 401 from a
  // bad secret and a 403 from a non-production context both reach us as 202. Anything not
  // checked up front is indistinguishable from a slow crawl.
  if (process.env.CONTEXT !== 'production') {
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: `Cataloging only runs in production (this deploy is "${process.env.CONTEXT ?? 'unset'}").`,
      }),
    };
  }

  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL;

  if (!secret || !siteUrl) {
    // Said plainly rather than as a generic 500: this exact configuration gap silently stopped
    // release cataloging from ever running, and "nothing happened" gave no clue why.
    console.error('[admin-catalog] INTERNAL_FUNCTION_SECRET or site URL is not configured');
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Cataloging is not configured on this deploy (INTERNAL_FUNCTION_SECRET).' }),
    };
  }

  await clearCooldown(artistId);

  try {
    const trigger: CatalogTrigger = 'saved'; // the larger hourly budget — this is a deliberate act
    await fetch(`${siteUrl}/.netlify/functions/catalog-artist-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ artistIds: [artistId], trigger }),
    });

    // Nothing useful to report back from that response, and deliberately no `started` flag:
    // the dispatcher's 202 says only that the request was queued, so any boolean derived from
    // it would read as "the crawl was accepted" while being true even when it wasn't. The
    // client polls the GET above, which reports what actually happened.
    return { statusCode: 202, headers: CORS_HEADERS, body: JSON.stringify({ queued: true }) };
  } catch (error) {
    Sentry.captureException(error);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Could not reach the cataloging function' }),
    };
  }
}

function safeParseArtistId(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body || '{}') as { artistId?: unknown };
    return typeof parsed.artistId === 'string' ? parsed.artistId : undefined;
  } catch {
    return undefined;
  }
}
