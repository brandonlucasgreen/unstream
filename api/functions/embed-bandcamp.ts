import { withSentry } from '../lib/sentry';
import { safeFetch } from './safe-fetch';
import { endpoint, type EndpointResult, type PublicRequest } from './http/endpoint';

// The url parameter comes straight from the request, so both fetches go through safeFetch,
// which refuses internal and private-network targets on every redirect hop. It isn't
// confined to *.bandcamp.com: release links can be a Bandcamp Pro artist's custom domain.

// Fetch Bandcamp embed data for an artist, album, or track URL
async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    // Check if the URL is already an album or track page
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    const response = await safeFetch(url, 5000);

    if (!response?.ok) return null;

    const html = await response.text();

    // If we're on an album or track page, extract the ID directly
    if (isAlbumUrl || isTrackUrl) {
      const itemType = isAlbumUrl ? 'album' : 'track';

      // Try multiple patterns to find the item ID
      const directMatch = html.match(new RegExp(`${itemType}=(\\d+)`));
      const jsonMatch = html.match(new RegExp(`"${itemType}_id"\\s*:\\s*(\\d+)`));
      const currentIdMatch = html.match(/"current"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);

      const idMatch = directMatch || jsonMatch || currentIdMatch;
      if (!idMatch) return null;

      const itemId = idMatch[1];

      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

      return {
        embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
        title,
      };
    }

    // Otherwise, it's an artist page - look for album or track links
    const albumMatch = html.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = html.match(/href="(\/track\/[^"]+)"/);

    let itemPath = albumMatch?.[1] || trackMatch?.[1];
    const itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    if (!itemPath) {
      const trackIdMatch = html.match(/data-item-id="track-(\d+)"/);
      if (trackIdMatch) {
        const trackId = trackIdMatch[1];
        return {
          embedUrl: `https://bandcamp.com/EmbeddedPlayer/track=${trackId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
          title: 'Track',
        };
      }
      return null;
    }

    // Extract base URL for constructing the full item URL
    const baseUrl = url.replace(/\/$/, '').replace(/\/music$/, '');
    const itemUrl = baseUrl + itemPath;

    const itemResponse = await safeFetch(itemUrl, 5000);

    if (!itemResponse?.ok) return null;

    const itemHtml = await itemResponse.text();

    const idMatch = itemHtml.match(new RegExp(`${itemType}=(\\d+)`));
    if (!idMatch) return null;

    const itemId = idMatch[1];

    const titleMatch = itemHtml.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

    return {
      embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
      title,
    };
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Bandcamp embed error:', err.message);
    return null;
  }
}

// Netlify function handler
async function handleRequest({ query }: PublicRequest): Promise<EndpointResult> {
  const url = query.url;

  if (!url) {
    return { status: 400, body: { error: 'URL parameter is required' } };
  }

  try {
    const embedData = await getBandcampEmbed(url);

    if (embedData) {
      return {
        status: 200,
        body: embedData,
        headers: { 'Cache-Control': 's-maxage=3600, stale-while-revalidate' },
      };
    } else {
      return { status: 404, body: { error: 'Could not find embeddable content' } };
    }
  } catch (error) {
    console.error('Embed error:', error);
    return { status: 500, body: { error: 'Failed to fetch embed data' } };
  }
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'strict',
  jsonBody: false,
}, handleRequest));
