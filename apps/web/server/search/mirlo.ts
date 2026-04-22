import type { PlatformResult } from '../shared-types';
import { fetchWithTimeout } from '../shared-utils';

// Check if a Mirlo artist page exists (Mirlo is client-side rendered).
export async function searchMirlo(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  // Mirlo artist URLs use lowercase, no-space slugs
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '');
  const artistUrl = `https://mirlo.space/${normalizedQuery}`;

  try {
    const response = await fetchWithTimeout(artistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 3000);

    if (!response.ok) return results;

    const html = await response.text();

    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (ogTitleMatch) {
      const ogTitle = ogTitleMatch[1].toLowerCase();
      // If og:title is just "Mirlo", artist doesn't exist
      if (ogTitle !== 'mirlo' && ogTitle.includes(normalizedQuery.substring(0, 4))) {
        const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
        const imageUrl = ogImageMatch ? ogImageMatch[1] : undefined;

        results.push({
          sourceId: 'mirlo',
          name: ogTitleMatch[1],
          type: 'artist',
          url: artistUrl,
          imageUrl,
        });
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Mirlo search error:', error.message);
    }
  }

  return results;
}
