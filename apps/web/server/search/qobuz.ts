import type { LatestRelease } from '../shared-types';
import { fetchWithTimeout, normalizeForComparison } from '../shared-utils';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Search Qobuz for artists by scraping search results.
// Returns a map of normalized artist name -> direct Qobuz artist URL.
export async function searchQobuz(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.qobuz.com/us-en/search/artists/${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    }, 5000);

    if (!response.ok) {
      console.error('Qobuz search failed:', response.status);
      return results;
    }

    const html = await response.text();

    // Interpreter (artist) links: /us-en/interpreter/{slug}/{id}
    const interpreterRegex = /href="(\/us-en\/interpreter\/([^/]+)\/(\d+))"/g;
    let match;
    const queryNormalized = normalizeForComparison(query);

    while ((match = interpreterRegex.exec(html)) !== null && results.size < 10) {
      const [, path, slug] = match;
      const slugNormalized = slug.replace(/-/g, '');

      if (slugNormalized === queryNormalized ||
          slugNormalized.includes(queryNormalized) ||
          queryNormalized.includes(slugNormalized)) {
        const artistName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const normalizedName = normalizeForComparison(artistName);

        if (!results.has(normalizedName)) {
          results.set(normalizedName, `https://www.qobuz.com${path}`);
        }
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Qobuz search error:', error.message);
    }
  }

  return results;
}

// Qobuz is client-side rendered, so we extract album info from URL patterns.
// sortBy parameter ensures releases are sorted by date (most recent first).
export async function getQobuzLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    const sortedUrl = artistUrl.includes('?')
      ? `${artistUrl}&%5BsortBy%5D=main_catalog_date_desc`
      : `${artistUrl}?%5BsortBy%5D=main_catalog_date_desc`;

    const response = await fetchWithTimeout(sortedUrl, {
      headers: { 'User-Agent': USER_AGENT },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();

    // Qobuz album URLs: /us-en/album/{album-name-slug}/{id}
    const albumUrlMatch = html.match(/href="(\/us-en\/album\/([^/]+)\/(\d+))"/);
    if (!albumUrlMatch) return undefined;

    const [, path, albumSlug] = albumUrlMatch;

    const title = albumSlug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const fullUrl = `https://www.qobuz.com${path}`;

    let releaseDate: string | undefined;
    const dateMatch = html.match(/"releaseDate"[:\s]*"(\d{4}-\d{2}-\d{2})"/) ||
                      html.match(/(\d{4}-\d{2}-\d{2})/) ||
                      html.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
    if (dateMatch) {
      releaseDate = dateMatch[1];
    }

    return {
      title,
      type: 'album',
      url: fullUrl,
      imageUrl: undefined, // Qobuz images require JS rendering
      releaseDate,
    };
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Qobuz latest release fetch error:', error.message);
    }
    return undefined;
  }
}
