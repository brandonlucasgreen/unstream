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

// Resolve artist name from Spotify or Apple Music URL
async function resolveStreamingUrl(url: string): Promise<{ artistName: string; source: 'spotify' | 'apple' } | null> {
  try {
    // Handle Spotify URI format (spotify:artist:ID)
    if (url.startsWith('spotify:')) {
      const parts = url.split(':');
      if (parts.length >= 3) {
        // Convert URI to URL format
        url = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      }
    }

    // Check if it's a Spotify URL
    const spotifyMatch = url.match(/open\.spotify\.com\/(artist|album|track)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();

      // For artist pages, og:title is the artist name
      // For albums/tracks, we need to find the artist name differently
      const type = spotifyMatch[1];

      if (type === 'artist') {
        // Artist page: og:title is the artist name
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          return { artistName: titleMatch[1], source: 'spotify' };
        }
      } else {
        // Album/track page: look for artist in various places
        // Try og:description which often has "by Artist Name"
        const descMatch = html.match(/<meta\s+property="og:description"\s+content="[^"]*(?:by|from)\s+([^"·]+)/i) ||
                         html.match(/<meta\s+content="[^"]*(?:by|from)\s+([^"·]+)"\s+property="og:description"/i);
        if (descMatch) {
          return { artistName: descMatch[1].trim(), source: 'spotify' };
        }

        // Try to find artist link in the HTML
        const artistLinkMatch = html.match(/href="\/artist\/[^"]+">([^<]+)<\/a>/);
        if (artistLinkMatch) {
          return { artistName: artistLinkMatch[1].trim(), source: 'spotify' };
        }

        // Fallback: parse title which is often "Song - Artist" or "Album - Artist"
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const parts = titleMatch[1].split(/\s*[-–—]\s*/);
          if (parts.length >= 2) {
            // Usually format is "Track/Album - Artist - Spotify" or similar
            // Take the second part, removing " - Spotify" suffix if present
            let artist = parts[1].replace(/\s*[-–—]\s*Spotify.*$/i, '').trim();
            if (artist && artist.toLowerCase() !== 'spotify') {
              return { artistName: artist, source: 'spotify' };
            }
          }
        }
      }

      return null;
    }

    // Check if it's an Apple Music URL
    const appleMatch = url.match(/music\.apple\.com\/[a-z]{2}\/(artist|album|song)\/([^/]+)\/(\d+)/);
    if (appleMatch) {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();
      const type = appleMatch[1];

      // Helper to clean Apple Music suffixes from artist names
      const cleanAppleMusicSuffix = (name: string): string => {
        return name
          .replace(/\s+on\s+Apple\s*Music.*$/i, '')
          .replace(/\s*[-–—]\s*Apple\s*Music.*$/i, '')
          .replace(/\s*\|\s*Apple\s*Music.*$/i, '')
          .trim();
      };

      if (type === 'artist') {
        // Artist page: og:title is the artist name
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          const artistName = cleanAppleMusicSuffix(titleMatch[1]);
          return { artistName, source: 'apple' };
        }
      } else {
        // Album/song page: title format is usually "Song by Artist on Apple Music"
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          // First clean any Apple Music suffix, then extract artist
          const cleanedTitle = cleanAppleMusicSuffix(titleMatch[1]);
          // Extract artist name from "Song by Artist" pattern
          const byMatch = cleanedTitle.match(/^.+?\s+by\s+(.+)$/i);
          if (byMatch) {
            const artistName = cleanAppleMusicSuffix(byMatch[1]);
            return { artistName, source: 'apple' };
          }
        }

        // Try twitter:audio:artist_name meta tag
        const artistMeta = html.match(/<meta\s+name="twitter:audio:artist_name"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+name="twitter:audio:artist_name"/i);
        if (artistMeta) {
          return { artistName: cleanAppleMusicSuffix(artistMeta[1]), source: 'apple' };
        }
      }

      return null;
    }

    // Not a recognized URL format
    return null;
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('URL resolution error:', err.message);
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
    const result = await resolveStreamingUrl(url);

    if (result) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 's-maxage=86400, stale-while-revalidate',
        },
        body: JSON.stringify(result),
      };
    } else {
      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Could not resolve artist from URL' }),
      };
    }
  } catch (error) {
    console.error('Resolve error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Failed to resolve URL' }),
    };
  }
}
