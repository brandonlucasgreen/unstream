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

// Fetch Bandcamp embed data for an artist
async function getBandcampEmbed(artistUrl: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    const artistResponse = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!artistResponse.ok) return null;

    const artistHtml = await artistResponse.text();

    const albumMatch = artistHtml.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = artistHtml.match(/href="(\/track\/[^"]+)"/);

    let itemPath = albumMatch?.[1] || trackMatch?.[1];
    const itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    if (!itemPath) {
      const trackIdMatch = artistHtml.match(/data-item-id="track-(\d+)"/);
      if (trackIdMatch) {
        const trackId = trackIdMatch[1];
        return {
          embedUrl: `https://bandcamp.com/EmbeddedPlayer/track=${trackId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
          title: 'Track',
        };
      }
      return null;
    }

    const itemUrl = artistUrl.replace(/\/$/, '') + itemPath;
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
