import { fetchWithTimeout } from '../shared-utils';

// Faircamp webring directory cache (refreshed every 10 minutes)
let faircampDirectoryCache: Record<string, { title: string; artists: string[]; description: string }> | null = null;
let faircampCacheTime = 0;
const FAIRCAMP_CACHE_TTL = 10 * 60 * 1000;

export async function getFaircampDirectory(): Promise<Record<string, { title: string; artists: string[]; description: string }>> {
  const now = Date.now();
  if (faircampDirectoryCache && (now - faircampCacheTime) < FAIRCAMP_CACHE_TTL) {
    return faircampDirectoryCache;
  }

  try {
    const response = await fetchWithTimeout('https://faircamp.webr.ing/directory.json', {}, 5000);
    if (!response.ok) {
      console.error('Faircamp directory fetch failed:', response.status);
      return faircampDirectoryCache || {};
    }
    faircampDirectoryCache = await response.json() as Record<string, { title: string; artists: string[]; description: string }>;
    faircampCacheTime = now;
    return faircampDirectoryCache;
  } catch (error: any) {
    console.error('Faircamp directory fetch error:', error.message);
    return faircampDirectoryCache || {};
  }
}

// Returns a map of normalized artist name -> faircamp URL
export async function searchFaircamp(query: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const queryLower = query.toLowerCase();

  try {
    const directory = await getFaircampDirectory();

    for (const [domain, info] of Object.entries(directory)) {
      for (const artist of info.artists || []) {
        if (artist.toLowerCase().includes(queryLower) || queryLower.includes(artist.toLowerCase())) {
          const normalizedArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          results.set(normalizedArtist, `https://${domain}`);
        }
      }

      if (results.size >= 10) break;
    }
  } catch (error: any) {
    console.error('Faircamp search error:', error.message);
  }

  return results;
}
