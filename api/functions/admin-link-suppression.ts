// API endpoint: GET/POST/DELETE /api/admin/link-suppression
//
// Admin-only. Removes a single wrong platform link from search results without
// removing the artist — the case merge overrides can't express, e.g. a
// plausible-looking *.bandcamp.com page attached to a major artist who has no
// Bandcamp presence at all.

import { getClient, deleteStoredLinksForUrl, invalidateAdminListCache } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { normalizeForComparison, normalizeUrlForMatch } from './search-utils';
import { Sentry, withSentry } from '../lib/sentry';

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

async function handleRequest({ method, user: admin, query, body: parsedBody }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return {
      status: 500,
      body: { error: 'Database not configured' },
    };
  }

  // GET: list suppressions, newest first, for review and undo
  if (method === 'GET') {
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
        status: 500,
        body: { error: 'Failed to load suppressions' },
      };
    }

    return {
      status: 200,
      body: { suppressions: data || [] },
    };
  }

  // DELETE: undo a suppression. The link comes back on the next uncached search.
  if (method === 'DELETE') {
    const id = query.id;
    if (!id || !UUID_REGEX.test(id)) {
      return {
        status: 400,
        body: { error: 'A valid suppression id is required' },
      };
    }

    const { error } = await client.from('platform_link_suppressions').delete().eq('id', id);
    if (error) {
      console.error('[Admin] Failed to delete link suppression:', error);
      return {
        status: 500,
        body: { error: 'Failed to remove suppression' },
      };
    }

    // The search path caches this table for five minutes, so without this the link stays
    // suppressed for up to five minutes after an admin undid the suppression.
    await invalidateAdminListCache('link-suppressions');

    return { status: 200, body: { success: true } };
  }

  // POST from here on: the wrapper has already refused every other method.
  const body = parsedBody as {
    url?: string;
    source_id?: string | null;
    artist_name?: string | null;
    scope?: 'artist' | 'global';
    reason?: string | null;
  };

  const url = (body.url || '').trim();
  if (!url) {
    return {
      status: 400,
      body: { error: 'url is required' },
    };
  }

  if (!isStorableLinkUrl(url)) {
    return {
      status: 400,
      body: { error: 'url must be an http(s) link' },
    };
  }

  const scope = body.scope === 'global' ? 'global' : 'artist';
  const artistName = (body.artist_name || '').trim();
  if (scope === 'artist' && !artistName) {
    return {
      status: 400,
      body: { error: 'artist_name is required unless scope is "global"' },
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
      status: 500,
      body: {
        error: 'Failed to save suppression',
        detail: error.message || error.code || String(error),
      },
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
    status: 201,
    body: {
      success: true,
      suppression: data ?? null,
      alreadySuppressed,
      storedLinksRemoved: storedRemoved,
    },
  };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST', 'DELETE'],
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
