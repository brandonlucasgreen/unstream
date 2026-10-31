import { fetchWithTimeout, normalizeForComparison } from '../shared-utils';

// Search EVEN via Algolia API (direct-to-fan marketplace)
export async function searchEven(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Even's public search-only key (the one even.biz ships to browsers); see searchEven in
  // api/functions/search-sources.ts.
  const algoliaAppId = process.env.ALGOLIA_APP_ID || 'S64VD9CU46';
  const algoliaApiKey = process.env.ALGOLIA_API_KEY || 'eea52fd4a67d03678477ffdfbad362e2';

  try {
    const response = await fetchWithTimeout(`https://${algoliaAppId}-dsn.algolia.net/1/indexes/Artist/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': algoliaAppId,
        'X-Algolia-API-Key': algoliaApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage: 10 }),
    }, 5000);

    if (!response.ok) return results;

    const json = await response.json();
    const queryNormalized = normalizeForComparison(query);

    for (const hit of (json as { hits?: { name?: string; slug?: string; username?: string }[] }).hits || []) {
      const name = hit.name;
      const slug = hit.slug || hit.username;
      if (!name || !slug) continue;

      const normalizedName = normalizeForComparison(name);

      const isMatch = normalizedName === queryNormalized ||
        queryNormalized.startsWith(normalizedName) ||
        (normalizedName.startsWith(queryNormalized) && /^\d*$/.test(normalizedName.slice(queryNormalized.length)));

      if (isMatch && !results.has(normalizedName)) {
        results.set(normalizedName, `https://even.biz/artists/${slug}`);
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('EVEN search error:', error.message);
    }
  }

  return results;
}
