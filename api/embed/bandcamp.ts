import type { VercelRequest, VercelResponse } from '@vercel/node';

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
    // First, fetch the artist page to find an album or track
    const artistResponse = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!artistResponse.ok) return null;

    const artistHtml = await artistResponse.text();

    // Look for album or track links
    const albumMatch = artistHtml.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = artistHtml.match(/href="(\/track\/[^"]+)"/);

    let itemPath = albumMatch?.[1] || trackMatch?.[1];
    let itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    // If no album/track links found, check if the page itself is a track page
    if (!itemPath) {
      // Check for track ID directly on the page (for single-track artists)
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

    // Fetch the album/track page to get the ID
    const itemUrl = artistUrl.replace(/\/$/, '') + itemPath;
    const itemResponse = await fetchWithTimeout(itemUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!itemResponse.ok) return null;

    const itemHtml = await itemResponse.text();

    // Extract the item ID
    const idMatch = itemHtml.match(new RegExp(`${itemType}=(\\d+)`));
    if (!idMatch) return null;

    const itemId = idMatch[1];

    // Extract title
    const titleMatch = itemHtml.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

    return {
      embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
      title,
    };
  } catch (error: any) {
    console.error('Bandcamp embed error:', error.message);
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL parameter is required' });
    return;
  }

  try {
    const embedData = await getBandcampEmbed(url);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    if (embedData) {
      res.status(200).json(embedData);
    } else {
      res.status(404).json({ error: 'Could not find embeddable content' });
    }
  } catch (error) {
    console.error('Embed error:', error);
    res.status(500).json({ error: 'Failed to fetch embed data' });
  }
}
