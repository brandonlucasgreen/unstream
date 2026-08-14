// API endpoint: /api/me/bandcamp
// GET    — connection status: connected, username, sync state, item count, last sync.
// POST   — { username, password }: connect. Verifies against Bandcamp's Subsonic API,
//          stores the encrypted salted-token pair (never the password), starts a sync.
//          { resync: true }: re-run the import for an existing connection.
// DELETE — { deleteItems? }: disconnect. Deletes the credential row; optionally deletes
//          imported collection items too.
//
// Support Loop Step 1 (support-loop-spec.md). Credential rules from collection-spec.md §4:
// the password exists only inside the POST request — it is converted to the Subsonic
// (t, s) pair, encrypted (credential-crypto.ts), and discarded. It must never be logged,
// stored, echoed back, or attached to a Sentry event.

import { createClient } from '@supabase/supabase-js';
import { Sentry } from '../lib/sentry';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { encryptCredential, isCredentialKeyConfigured } from './credential-crypto';
import {
  deriveSubsonicToken,
  subsonicPing,
  subsonicArtistCount,
  SubsonicError,
} from './bandcamp-subsonic';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

interface ConnectionRow {
  bandcamp_username: string;
  sync_status: string;
  sync_error: string | null;
  item_count: number | null;
  last_synced_at: string | null;
}

function toStatusShape(row: ConnectionRow | null) {
  if (!row) return { connected: false as const };
  return {
    connected: true as const,
    username: row.bandcamp_username,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    itemCount: row.item_count,
    lastSyncedAt: row.last_synced_at,
  };
}

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id };
}

/**
 * Ask the background function to run the import. Returns false when it couldn't be asked
 * (missing config, network) — the caller records that as a sync error rather than leaving
 * the row claiming a sync that will never happen. Same handshake as request-catalog.ts:
 * Netlify answers 202 immediately, so there is no result to read back.
 */
async function requestSync(userId: string): Promise<boolean> {
  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  // `URL` and not `DEPLOY_PRIME_URL`: only URL, SITE_NAME and SITE_ID reach a function at
  // runtime — see request-catalog.ts.
  const siteUrl = process.env.URL;
  if (!secret || !siteUrl) {
    console.log('[me-bandcamp] sync not requested — INTERNAL_FUNCTION_SECRET or site URL not configured');
    return false;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    let response: Response;
    try {
      response = await fetch(`${siteUrl}/.netlify/functions/bandcamp-sync-background`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    // Netlify's dispatcher answers 202 when it accepts a background invocation. Anything
    // else means the sync will never run — notably a 404 when this code runs on a deploy
    // preview, whose `URL` points at production before the function has shipped there.
    // Claiming "syncing" on that response would spin forever.
    if (!response.ok) {
      console.warn(`[me-bandcamp] sync dispatch refused: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[me-bandcamp] sync request failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

const SYNC_START_FAILED = 'Sync could not be started. Use Re-sync to try again.';

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  const client = getClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  if (event.httpMethod === 'GET') {
    const { data: row, error } = await client
      .from('bandcamp_connections')
      .select('bandcamp_username, sync_status, sync_error, item_count, last_synced_at')
      .eq('user_id', user.userId)
      .maybeSingle();

    if (error) {
      console.error('[me-bandcamp] Error fetching connection:', error.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to load connection status' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(toStatusShape(row)) };
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    // Re-sync an existing connection.
    if (body.resync === true) {
      const { data: existing, error } = await client
        .from('bandcamp_connections')
        .select('sync_status')
        .eq('user_id', user.userId)
        .maybeSingle();
      if (error) {
        console.error('[me-bandcamp] Error checking connection for resync:', error.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to start sync' }) };
      }
      if (!existing) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No Bandcamp connection to sync' }) };
      }
      if (existing.sync_status === 'syncing') {
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'A sync is already running' }) };
      }

      // Mark syncing before asking: the background function reads this row, so the
      // status write must land first (same ordering as connect below).
      const { error: markError } = await client
        .from('bandcamp_connections')
        .update({ sync_status: 'syncing', sync_error: null })
        .eq('user_id', user.userId);
      if (markError) {
        console.error('[me-bandcamp] Error updating sync status:', markError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to start sync' }) };
      }

      const started = await requestSync(user.userId);
      if (!started) {
        await client
          .from('bandcamp_connections')
          .update({ sync_status: 'error', sync_error: SYNC_START_FAILED })
          .eq('user_id', user.userId);
      }

      const { data: row, error: readError } = await client
        .from('bandcamp_connections')
        .select('bandcamp_username, sync_status, sync_error, item_count, last_synced_at')
        .eq('user_id', user.userId)
        .single();
      if (readError) {
        console.error('[me-bandcamp] Error reading connection after resync:', readError.message);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to start sync' }) };
      }
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(toStatusShape(row)) };
    }

    // Connect.
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || username.length > 200) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'The username Bandcamp generated is required' }) };
    }
    if (!password || password.length > 500) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'The password Bandcamp generated is required' }) };
    }

    if (!isCredentialKeyConfigured()) {
      // Configuration, not user error — and worth a Sentry event because the feature is
      // silently unusable until the env var lands.
      console.error('[me-bandcamp] BANDCAMP_CREDENTIAL_KEY is not configured');
      Sentry.captureMessage('me-bandcamp: BANDCAMP_CREDENTIAL_KEY not configured', 'error');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Bandcamp connections are not available right now' }) };
    }

    // Derive the salted token; the password is not referenced again after this line.
    const { t, s } = deriveSubsonicToken(password);
    const credential = { username, t, s };

    // Verify before storing: a stored credential that never worked would surface as a
    // confusing background sync failure instead of an inline "check your credential".
    try {
      await subsonicPing(credential);
    } catch (error) {
      if (error instanceof SubsonicError && error.isAuthFailure) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Bandcamp rejected that username or password. Check both against Fan Settings → Subsonic on Bandcamp.' }),
        };
      }
      console.warn('[me-bandcamp] Bandcamp ping failed:', error instanceof Error ? error.message : String(error));
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Bandcamp didn’t respond. Their Subsonic support is in beta — try again in a minute.' }),
      };
    }

    // A nice-to-have confirmation number; a failure here shouldn't block the connect.
    let artistCount: number | null = null;
    try {
      artistCount = await subsonicArtistCount(credential);
    } catch {
      // The sync will establish real counts.
    }

    const ciphertext = encryptCredential(JSON.stringify({ t, s }));

    // Store first, then ask for the sync: the background function reads this row, so
    // requesting before the upsert lands would race it into "no connection found".
    const { error: upsertError } = await client
      .from('bandcamp_connections')
      .upsert(
        {
          user_id: user.userId,
          bandcamp_username: username,
          credential_ciphertext: ciphertext,
          sync_status: 'syncing',
          sync_error: null,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('[me-bandcamp] Error storing connection:', upsertError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to save the connection' }) };
    }

    const started = await requestSync(user.userId);
    if (!started) {
      await client
        .from('bandcamp_connections')
        .update({ sync_status: 'error', sync_error: SYNC_START_FAILED })
        .eq('user_id', user.userId);
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        connected: true,
        username,
        syncStatus: started ? 'syncing' : 'error',
        syncError: started ? null : SYNC_START_FAILED,
        artistCount,
      }),
    };
  }

  if (event.httpMethod === 'DELETE') {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { error: deleteError } = await client
      .from('bandcamp_connections')
      .delete()
      .eq('user_id', user.userId);

    if (deleteError) {
      console.error('[me-bandcamp] Error deleting connection:', deleteError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to disconnect' }) };
    }

    let itemsDeleted = 0;
    if (body.deleteItems === true) {
      const { count, error: itemsError } = await client
        .from('collection_items')
        .delete({ count: 'exact' })
        .eq('user_id', user.userId)
        .eq('source', 'bandcamp');
      if (itemsError) {
        console.error('[me-bandcamp] Error deleting collection items:', itemsError.message);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Disconnected, but deleting imported items failed. Try again from Settings.' }),
        };
      }
      itemsDeleted = count ?? 0;
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ connected: false, itemsDeleted }) };
  }

  return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
}
