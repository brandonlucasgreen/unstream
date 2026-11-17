// V1 API: /api/v1/artist/{slug}
// The stored artist, behind what every v1 endpoint has: an optional API key, the key's own
// quota and its headers, a request ID and the response envelope. The wrapper supplies all of
// those (`auth: 'apiKey'`, `envelope: 'v1'`).

import { withSentry } from '../lib/sentry';
import { endpoint } from './http/endpoint';
import { getArtistBySlug, resolveArtistSlugAlias } from './db';
import { decodePathSegment } from '../shared/path-segments';

export const handler = withSentry(endpoint({
  cors: 'siteOrApiKey',
  methods: ['GET'],
  auth: 'apiKey',
  envelope: 'v1',
  jsonBody: false,
}, async ({ query, path, apiKey }) => {
  // Extract slug from path or query string
  // Netlify redirect-based routes pass the full path; extract slug from /api/v1/artist/{slug}
  let slug: string | undefined;
  const match = path.match(/\/api\/v1\/artist\/([^/]+)$/);
  // Left undefined when the segment can't be decoded, so the "slug required" answer below
  // handles it. decodeURIComponent raises URIError on a malformed escape, which reached a
  // public endpoint as a 500 from code that hadn't looked anything up yet.
  if (match) slug = decodePathSegment(match[1]) ?? undefined;
  if (!slug) slug = query.slug;

  if (!slug) {
    return { status: 400, body: { error: 'Artist slug is required. Use /api/v1/artist/{slug}' } };
  }

  let artist = await getArtistBySlug(slug);

  // A retired slug (merge loser, or an accent re-slug) still resolves. Third-party integrations
  // hold onto these, so silently 404ing one would break their stored links.
  if (!artist) {
    const { canonical, failed: aliasFailed } = await resolveArtistSlugAlias(slug);
    // A broken alias read is an outage, not a verdict: thrown, so the wrapper reports it and
    // answers 500, rather than 404 an artist whose old URL we simply couldn't check.
    if (aliasFailed) throw new Error('[artist-lookup-v1] alias lookup failed');
    if (canonical) artist = await getArtistBySlug(canonical);
  }

  if (!artist) {
    return { status: 404, body: { error: 'Artist not found' } };
  }

  return {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': apiKey ? 's-maxage=14400, stale-while-revalidate=3600' : 's-maxage=1800, stale-while-revalidate=300',
      'Cache-Tag': `artist-${slug}`,
    },
    body: artist,
  };
}));
