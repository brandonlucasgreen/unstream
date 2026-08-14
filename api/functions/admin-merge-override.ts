// API endpoint: POST /api/admin/merge-override
// Admin-only endpoint for creating artist merge overrides from the UI.

import { getClient, invalidateAdminListCache } from './db';
import { authenticateAdmin } from './middleware';
import { isSearchOnlyLink, sourceIdFromUrl } from './search-utils';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization'] || undefined);
  if (!admin) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  let body: {
    group_name?: string;
    platform_urls?: string[];
    excluded_urls?: string[];
    canonical_image_url?: string | null;
    notes?: string | null;
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

  const { group_name, platform_urls, excluded_urls, canonical_image_url, notes } = body;

  if (!group_name?.trim()) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'group_name is required' }),
    };
  }

  if (!Array.isArray(platform_urls) || platform_urls.length < 2) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'At least 2 platform_urls are required' }),
    };
  }

  // Strip generic search/explore URLs — they appear in every query's results
  // and would make the override's relevance check match unrelated searches.
  const filteredPlatformUrls = platform_urls.filter(url => {
    const sid = sourceIdFromUrl(url);
    return sid ? !isSearchOnlyLink({ sourceId: sid, url }) : true;
  });

  if (filteredPlatformUrls.length < 2) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'At least 2 non-search platform_urls are required' }),
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

  const { data, error } = await client
    .from('artist_merge_overrides')
    .insert({
      group_name: group_name.trim(),
      platform_urls: filteredPlatformUrls,
      excluded_urls: excluded_urls || [],
      canonical_image_url: canonical_image_url || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[Admin] Failed to insert merge override:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'Failed to save merge override',
        detail: error.message || error.code || String(error),
      }),
    };
  }

  // The search path caches this table for five minutes, so without this the duplicate results
  // the admin just merged stay unmerged for up to five minutes.
  await invalidateAdminListCache('merge-overrides');

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, override: data }),
  };
}
