// Helper to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Fetch Bandcamp embed data for an artist, album, or track URL
async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    // Check if the URL is already an album or track page
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return null;

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

    const itemResponse = await fetchWithTimeout(itemUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!itemResponse.ok) return null;

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
export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const url = event.queryStringParameters?.url;

  if (!url) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'URL parameter is required' }),
    };
  }

  try {
    const embedData = await getBandcampEmbed(url);

    if (embedData) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 's-maxage=3600, stale-while-revalidate',
        },
        body: JSON.stringify(embedData),
      };
    } else {
      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Could not find embeddable content' }),
      };
    }
  } catch (error) {
    console.error('Embed error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Failed to fetch embed data' }),
    };
  }
}
