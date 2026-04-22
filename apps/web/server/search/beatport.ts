import { parse } from 'node-html-parser';
import { fetchWithTimeout, normalizeForComparison } from '../shared-utils';

// Search Beatport via __NEXT_DATA__ JSON embedded in search page
export async function searchBeatport(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return results;

    const html = await response.text();
    const root = parse(html);
    const scriptEl = root.querySelector('script#__NEXT_DATA__');
    if (!scriptEl) return results;

    const json = JSON.parse(scriptEl.textContent);
    const queries = json?.props?.pageProps?.dehydratedState?.queries;
    let artists: { artist_id: number; artist_name: string }[] | undefined;
    for (const q of queries || []) {
      const data = q?.state?.data?.artists?.data;
      if (Array.isArray(data)) {
        artists = data;
        break;
      }
    }
    if (!artists) return results;

    const queryNormalized = normalizeForComparison(query);

    for (const artist of artists.slice(0, 10)) {
      const { artist_name, artist_id } = artist;
      if (!artist_name || !artist_id) continue;

      const normalizedName = normalizeForComparison(artist_name);

      const isMatch = normalizedName === queryNormalized ||
        queryNormalized.startsWith(normalizedName) ||
        (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

      if (isMatch && !results.has(normalizedName)) {
        const slug = artist_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        results.set(normalizedName, `https://www.beatport.com/artist/${slug}/${artist_id}`);
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Beatport search error:', error.message);
    }
  }

  return results;
}
