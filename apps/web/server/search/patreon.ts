import { fetchWithTimeout, normalizeForComparison } from '../shared-utils';

// Search Patreon API for creators matching the query.
// Returns a map of normalized creator name -> Patreon URL.
// Also indexes by URL slug to catch cases like "Mo-Rice" (URL: /Mo_Rice, campaign: "Mo-bility Station").
export async function searchPatreon(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const searchUrl = `https://www.patreon.com/api/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, 5000);

    if (!response.ok) {
      console.error('Patreon search failed:', response.status);
      return results;
    }

    const data = await response.json() as {
      data?: {
        type: string;
        attributes?: {
          creator_name?: string;
          url?: string;
        };
      }[];
    };

    const campaigns = data.data || [];

    for (const campaign of campaigns) {
      if (campaign.type === 'campaign-document' && campaign.attributes) {
        const creatorName = campaign.attributes.creator_name;
        const url = campaign.attributes.url;

        if (creatorName && url) {
          const normalizedName = normalizeForComparison(creatorName);
          if (!results.has(normalizedName)) {
            results.set(normalizedName, url);
          }

          // Also index by URL slug (e.g., /Mo_Rice -> morice)
          const urlSlug = url.split('/').pop();
          if (urlSlug) {
            const normalizedSlug = normalizeForComparison(urlSlug);
            if (!results.has(normalizedSlug)) {
              results.set(normalizedSlug, url);
            }
          }
        }
      }

      if (results.size >= 20) break;
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Patreon search error:', error.message);
    }
  }

  return results;
}
