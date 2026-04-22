import { fetchWithTimeout } from './shared-utils';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Resolve artist name from Spotify or Apple Music URL
export async function resolveStreamingUrl(url: string): Promise<{ artistName: string; source: 'spotify' | 'apple' } | null> {
  try {
    // Handle Spotify URI format (spotify:artist:ID)
    if (url.startsWith('spotify:')) {
      const parts = url.split(':');
      if (parts.length >= 3) {
        url = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      }
    }

    // Spotify URL
    const spotifyMatch = url.match(/open\.spotify\.com\/(artist|album|track)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': USER_AGENT },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();
      const type = spotifyMatch[1];

      if (type === 'artist') {
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          return { artistName: titleMatch[1], source: 'spotify' };
        }
      } else {
        // Album/track: look for artist in og:description ("by Artist Name")
        const descMatch = html.match(/<meta\s+property="og:description"\s+content="[^"]*(?:by|from)\s+([^"·]+)/i) ||
                         html.match(/<meta\s+content="[^"]*(?:by|from)\s+([^"·]+)"\s+property="og:description"/i);
        if (descMatch) {
          return { artistName: descMatch[1].trim(), source: 'spotify' };
        }

        const artistLinkMatch = html.match(/href="\/artist\/[^"]+">([^<]+)<\/a>/);
        if (artistLinkMatch) {
          return { artistName: artistLinkMatch[1].trim(), source: 'spotify' };
        }

        // Fallback: parse title, usually "Track/Album - Artist - Spotify"
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const parts = titleMatch[1].split(/\s*[-–—]\s*/);
          if (parts.length >= 2) {
            const artist = parts[1].replace(/\s*[-–—]\s*Spotify.*$/i, '').trim();
            if (artist && artist.toLowerCase() !== 'spotify') {
              return { artistName: artist, source: 'spotify' };
            }
          }
        }
      }

      return null;
    }

    // Apple Music URL
    const appleMatch = url.match(/music\.apple\.com\/[a-z]{2}\/(artist|album|song)\/([^/]+)\/(\d+)/);
    if (appleMatch) {
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': USER_AGENT },
      }, 5000);

      if (!response.ok) return null;

      const html = await response.text();
      const type = appleMatch[1];

      if (type === 'artist') {
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          // Strip "- Apple Music" / "on Apple Music" suffixes
          const artistName = titleMatch[1]
            .replace(/\s*[-–—]\s*Apple Music.*$/i, '')
            .replace(/\s+on Apple Music.*$/i, '')
            .trim();
          return { artistName, source: 'apple' };
        }
      } else {
        // Album/song: title format is usually "Album/Song by Artist" or "... on Apple Music"
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          const byMatch = titleMatch[1].match(/^.+?\s+by\s+(.+?)(?:\s+on Apple Music|\s*[-–—]\s*Apple Music)?$/i);
          if (byMatch) {
            return { artistName: byMatch[1].trim(), source: 'apple' };
          }
        }

        const artistMeta = html.match(/<meta\s+name="twitter:audio:artist_name"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+name="twitter:audio:artist_name"/i);
        if (artistMeta) {
          return { artistName: artistMeta[1], source: 'apple' };
        }
      }

      return null;
    }

    return null;
  } catch (error: any) {
    console.error('URL resolution error:', error.message);
    return null;
  }
}
