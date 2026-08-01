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

async function readState(artistId: string): Promise<CatalogState | null> {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('release_catalog_state')
    .select('last_catalogued_at, last_attempted_at, releases_found, releases_detailed, last_error, consecutive_failures')
    .eq('artist_id', artistId)
    .maybeSingle();

  if (error) {
    console.error('[admin-catalog] state read failed:', error.message);
    return null;
  }
  return (data as CatalogState | null) ?? null;
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
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ admin: true, state: await readState(artistId) }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
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
    const response = await fetch(`${siteUrl}/.netlify/functions/catalog-artist-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ artistIds: [artistId], trigger }),
    });

    // A background function answers 202 the moment it accepts the job — including when it is
    // about to refuse on a bad secret. This status is a handshake, not an outcome, so the client
    // polls the GET above for what actually happened.
    return {
      statusCode: 202,
      headers: CORS_HEADERS,
      body: JSON.stringify({ started: response.status === 202 || response.ok }),
    };
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
