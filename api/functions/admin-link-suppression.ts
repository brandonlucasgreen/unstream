// API endpoint: GET/POST/DELETE /api/admin/link-suppression
//
// Admin-only. Removes a single wrong platform link from search results without
// removing the artist — the case merge overrides can't express, e.g. a
// plausible-looking *.bandcamp.com page attached to a major artist who has no
// Bandcamp presence at all.

import { getClient, deleteStoredLinksForUrl, invalidateAdminListCache } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';
import { normalizeForComparison, normalizeUrlForMatch } from './search-utils';
import { Sentry } from '../lib/sentry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A URL shaped like something the search pipeline could have produced.
 *
 * Deliberately not the SSRF allowlist (isUrlHostnameAllowed): that list covers
 * hosts we *fetch*, and the whole point here is to remove links we never fetch —
 * social profiles, official sites, Qobuz, MusicBrainz-supplied URLs. Nothing
 * requests this URL; it is only compared against search results and displayed in
 * the admin list, so the check just rejects non-web schemes and nonsense.
 */
function isStorableLinkUrl(url: string): boolean {
  if (url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return parsed.hostname.includes('.');
  } catch {
    return false;
  }
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

  const admin = await authenticateAdmin(
    event.headers['authorization'] || event.headers['Authorization'] || undefined
  );
  if (!admin) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const client = getClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Database not configured' }),
    };
  }

  // GET: list suppressions, newest first, for review and undo
  if (event.httpMethod === 'GET') {
    const { data, error } = await client
      .from('platform_link_suppressions')
      .select('id, url, source_id, artist_name, artist_name_norm, reason, created_by, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('[Admin] Failed to list link suppressions:', error);
      Sentry.captureMessage('Admin link suppression list failed', {
        level: 'error',
        extra: { detail: error.message },
      });
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to load suppressions' }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ suppressions: data || [] }),
    };
  }

  // DELETE: undo a suppression. The link comes back on the next uncached search.
  if (event.httpMethod === 'DELETE') {
    const id = event.queryStringParameters?.id;
    if (!id || !UUID_REGEX.test(id)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'A valid suppression id is required' }),
      };
    }

    const { error } = await client.from('platform_link_suppressions').delete().eq('id', id);
    if (error) {
      console.error('[Admin] Failed to delete link suppression:', error);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to remove suppression' }),
      };
    }

    // The search path caches this table for five minutes, so without this the link stays
    // suppressed for up to five minutes after an admin undid the suppression.
    await invalidateAdminListCache('link-suppressions');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body: {
    url?: string;
    source_id?: string | null;
    artist_name?: string | null;
    scope?: 'artist' | 'global';
    reason?: string | null;
  };

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const url = (body.url || '').trim();
  if (!url) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'url is required' }),
    };
  }

  if (!isStorableLinkUrl(url)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'url must be an http(s) link' }),
    };
  }

  const scope = body.scope === 'global' ? 'global' : 'artist';
  const artistName = (body.artist_name || '').trim();
  if (scope === 'artist' && !artistName) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'artist_name is required unless scope is "global"' }),
    };
  }

  const normalizedUrl = normalizeUrlForMatch(url);
  const row = {
    url: normalizedUrl,
    source_id: body.source_id || null,
    artist_name: artistName || null,
    // Null scope = suppress everywhere; partial unique indexes keep one row per
    // (url, artist) and one global row per url.
    artist_name_norm: scope === 'global' ? null : normalizeForComparison(artistName),
    reason: (body.reason || '').trim() || null,
    created_by: admin.email,
  };

  const { data, error } = await client
    .from('platform_link_suppressions')
    .insert(row)
    .select()
    .single();

  // Already suppressed at this scope — the admin clicked twice, or two tabs are
  // open. Treat as success rather than surfacing a database error.
  const alreadySuppressed = error?.code === '23505';

  if (error && !alreadySuppressed) {
    console.error('[Admin] Failed to save link suppression:', error);
    Sentry.captureMessage('Admin link suppression save failed', {
      level: 'error',
      extra: { detail: error.message, url: normalizedUrl, scope },
    });
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'Failed to save suppression',
        detail: error.message || error.code || String(error),
      }),
    };
  }

  // The search path caches this table for five minutes, so without this the suppressed link
  // keeps appearing in results for up to five minutes after the admin suppressed it.
  await invalidateAdminListCache('link-suppressions');

  // Also clear stored copies, so the link disappears from the artist page and
  // from DB-backed search cards rather than only from freshly fetched results.
  const storedRemoved = await deleteStoredLinksForUrl(
    normalizedUrl,
    scope === 'global' ? null : artistName
  );

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      suppression: data ?? null,
      alreadySuppressed,
      storedLinksRemoved: storedRemoved,
    }),
  };
}
