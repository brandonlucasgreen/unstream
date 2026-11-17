// API endpoint: POST /api/admin/merge-override
// Admin-only endpoint for creating artist merge overrides from the UI.

import { withSentry } from '../lib/sentry';
import { getClient, invalidateAdminListCache } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { isSearchOnlyLink, sourceIdFromUrl } from './search-utils';

async function handleRequest({ body }: SignedInRequest): Promise<EndpointResult> {
  const { group_name, platform_urls, excluded_urls, canonical_image_url, notes } = body as {
    group_name?: string;
    platform_urls?: string[];
    excluded_urls?: string[];
    canonical_image_url?: string | null;
    notes?: string | null;
  };

  if (!group_name?.trim()) {
    return { status: 400, body: { error: 'group_name is required' } };
  }

  if (!Array.isArray(platform_urls) || platform_urls.length < 2) {
    return { status: 400, body: { error: 'At least 2 platform_urls are required' } };
  }

  // Strip generic search/explore URLs — they appear in every query's results
  // and would make the override's relevance check match unrelated searches.
  const filteredPlatformUrls = platform_urls.filter(url => {
    const sid = sourceIdFromUrl(url);
    return sid ? !isSearchOnlyLink({ sourceId: sid, url }) : true;
  });

  if (filteredPlatformUrls.length < 2) {
    return { status: 400, body: { error: 'At least 2 non-search platform_urls are required' } };
  }

  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
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
      status: 500,
      body: {
        error: 'Failed to save merge override',
        detail: error.message || error.code || String(error),
      },
    };
  }

  // The search path caches this table for five minutes, so without this the duplicate results
  // the admin just merged stay unmerged for up to five minutes.
  await invalidateAdminListCache('merge-overrides');

  return { status: 201, body: { success: true, override: data } };
}

export const handler = withSentry(endpoint({
  // The site and the local dev origins, never '*': this endpoint takes a Bearer token
  // (account-cors.ts says why).
  cors: 'account',
  methods: ['POST'],
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
