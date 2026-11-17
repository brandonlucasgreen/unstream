// API endpoint: /api/artist?slug=artist-name
// Looks up an artist from the Supabase database.
// Returns the artist with all links, or 404 if not found.

import { withSentry } from '../lib/sentry';
import { getArtistBySlug, resolveArtistSlugAlias } from './db';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

async function handleRequest({ query }: PublicRequest): Promise<EndpointResult> {
  const slug = query.slug;

  if (!slug) {
    return { status: 400, body: { error: 'slug parameter is required' } };
  }

  let artist = await getArtistBySlug(slug);

  // Only on a miss, and only here: a live slug always wins, and getArtistBySlug is on the search
  // hot path so it must not pay for this. An alias means the artist was merged into another row or
  // re-slugged when accent folding was fixed — either way the old URL should still work.
  if (!artist) {
    const { canonical, failed: aliasFailed } = await resolveArtistSlugAlias(slug);
    // A broken alias read is an outage, not a verdict — throw, which the wrapper answers with a
    // 500, rather than 404 an artist whose old URL we simply couldn't check.
    if (aliasFailed) throw new Error('[artist-lookup] alias lookup failed');
    if (canonical) artist = await getArtistBySlug(canonical);
  }

  if (!artist) {
    return { status: 404, body: { error: 'Artist not found' } };
  }

  return {
    status: 200,
    body: artist,
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': 's-maxage=60, stale-while-revalidate=60',
      'Cache-Tag': `artist-${slug}`,
    },
  };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'standard',
  jsonBody: false,
}, handleRequest));
