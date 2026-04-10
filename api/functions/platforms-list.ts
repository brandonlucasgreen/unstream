// V1 API: /api/v1/platforms
// Returns the list of supported platforms with their IDs, names, and categories.
// No authentication required — this is public metadata.

import { CURATED_PLATFORMS, SEARCH_ONLY_PLATFORMS } from './search-utils';
import { buildPublicCorsHeaders, generateRequestId, v1Response } from './middleware';

interface PlatformInfo {
  id: string;
  name: string;
  category: 'curated' | 'search_only';
  url?: string;
}

export async function handler(event: { httpMethod: string; headers?: Record<string, string | undefined> }) {
  const requestId = generateRequestId();
  const corsHeaders = buildPublicCorsHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify(v1Response({ error: 'Method not allowed. Use GET.' }, requestId)),
    };
  }

  const platforms: PlatformInfo[] = [];

  for (const id of CURATED_PLATFORMS) {
    platforms.push({
      id,
      name: getPlatformName(id),
      category: 'curated',
    });
  }

  for (const id of SEARCH_ONLY_PLATFORMS) {
    platforms.push({
      id,
      name: getPlatformName(id),
      category: 'search_only',
    });
  }

  // Add additional platforms not in the curated/search-only sets
  const additionalPlatforms: PlatformInfo[] = [
    { id: 'bandcamp', name: 'Bandcamp', category: 'curated' },
    { id: 'qobuz', name: 'Qobuz', category: 'curated' },
    { id: 'beatport', name: 'Beatport', category: 'curated' },
    { id: 'even', name: 'EVEN', category: 'curated' },
    { id: 'nina', name: 'Nina', category: 'curated' },
    { id: 'artcore', name: 'Artcore', category: 'curated' },
    { id: 'ampwall', name: 'Ampwall', category: 'curated' },
    { id: 'patreon', name: 'Patreon', category: 'curated' },
    { id: 'officialsite', name: 'Official Website', category: 'curated' },
    { id: 'discogs', name: 'Discogs', category: 'curated' },
  ];

  // Merge, deduplicating by id
  const seen = new Set(platforms.map(p => p.id));
  for (const p of additionalPlatforms) {
    if (!seen.has(p.id)) {
      platforms.push(p);
      seen.add(p.id);
    }
  }

  // Sort: curated first, then search_only, alphabetically within each
  platforms.sort((a, b) => {
    if (a.category !== b.category) return a.category === 'curated' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'X-Request-Id': requestId,
      'Cache-Control': 'public, max-age=3600',
      'Netlify-CDN-Cache-Control': 's-maxage=86400',
    },
    body: JSON.stringify(v1Response({ platforms }, requestId)),
  };
}

function getPlatformName(id: string): string {
  const names: Record<string, string> = {
    'mirlo': 'Mirlo',
    'faircamp': 'Faircamp',
    'jamcoop': 'Jam.coop',
    'kofi': 'Ko-fi',
    'buymeacoffee': 'Buy Me a Coffee',
    'bandcamp': 'Bandcamp',
    'qobuz': 'Qobuz',
    'beatport': 'Beatport',
    'even': 'EVEN',
    'nina': 'Nina',
    'artcore': 'Artcore',
    'ampwall': 'Ampwall',
    'patreon': 'Patreon',
    'officialsite': 'Official Website',
    'discogs': 'Discogs',
    'bandwagon': 'Bandwagon',
  };
  return names[id] || id.charAt(0).toUpperCase() + id.slice(1);
}