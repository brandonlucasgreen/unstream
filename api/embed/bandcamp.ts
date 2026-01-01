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

// Fetch Bandcamp embed data for an artist, album, or track URL
async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    // Check if the URL is already an album or track page
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    // Fetch the page
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

      // Check if this content is embeddable
      const embeddableMatch = html.match(/"public_embeddable":(true|false)/);
      if (embeddableMatch && embeddableMatch[1] === 'false') {
        console.log('Bandcamp content is not publicly embeddable');
        return null;
      }

      // Try multiple patterns to find the item ID
      // Pattern 1: tralbum_param in data-embed JSON
      const tralbumMatch = html.match(/"tralbum_param":\s*\{\s*"name"\s*:\s*"(album|track)"\s*,\s*"value"\s*:\s*(\d+)\s*\}/);
      // Pattern 2: Direct album= or track= in URL or script
      const directMatch = html.match(new RegExp(`${itemType}=(\\d+)`));
      // Pattern 3: data attribute
      const dataMatch = html.match(new RegExp(`data-${itemType}-id="(\\d+)"`));
      // Pattern 4: JSON property
      const jsonMatch = html.match(new RegExp(`"${itemType}_id"\\s*:\\s*(\\d+)`));
      // Pattern 5: "id" in current object for album/track
      const currentIdMatch = html.match(/"current"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);

      const idMatch = tralbumMatch || directMatch || dataMatch || jsonMatch || currentIdMatch;
      if (!idMatch) return null;

      // Get the ID from the appropriate capture group
      const itemId = tralbumMatch ? tralbumMatch[2] : idMatch[1];

      // Extract title
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
    let itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    // If no album/track links found, check if the page itself is a track page
    if (!itemPath) {
      // Check for track ID directly on the page (for single-track artists)
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
