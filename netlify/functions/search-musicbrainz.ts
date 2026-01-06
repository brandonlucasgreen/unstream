// MusicBrainz search response for lazy loading
interface MusicBrainzSearchResponse {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
}

// Helper to delay execution (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Search MusicBrainz for artist info including official website, Discogs, and release history
async function searchMusicBrainz(query: string): Promise<MusicBrainzSearchResponse> {
  const emptyResult: MusicBrainzSearchResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
  };

  try {
    // Search for artist
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return emptyResult;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return emptyResult;

    const artist = artists[0];
    // Only consider exact/near-exact matches
    if (artist.score < 95) return emptyResult;

    // Wait 1.1 seconds to respect MusicBrainz rate limit (1 req/sec)
    await delay(1100);

    // Fetch artist details with URL relations
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let officialUrl: string | null = null;
    let discogsUrl: string | null = null;

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: {
          type: string;
          url?: { resource: string };
        }[];
      };

      const relations = artistData.relations || [];

      // Look for official homepage
      for (const rel of relations) {
        if (rel.type === 'official homepage' && rel.url?.resource) {
          officialUrl = rel.url.resource;
          break;
        }
      }

      // Look for Discogs link
      for (const rel of relations) {
        if (rel.type === 'discogs' && rel.url?.resource) {
          discogsUrl = rel.url.resource;
          break;
        }
      }
    }

    // Wait again before next request
    await delay(1100);

    // Check if artist has pre-2005 releases (for Hoopla/Freegal eligibility)
    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: {
        'User-Agent': 'Unstream/1.0 (https://github.com/unstream - ethical music finder)',
      },
    });

    let hasPre2005Release = false;

    if (releasesResponse.ok) {
      const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
      const releaseGroups = releasesData['release-groups'] || [];

      for (const rg of releaseGroups) {
        const firstReleaseDate = rg['first-release-date'];
        if (firstReleaseDate) {
          const year = parseInt(firstReleaseDate.substring(0, 4), 10);
          if (year < 2005) {
            hasPre2005Release = true;
            break;
          }
        }
      }
    }

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    console.error('MusicBrainz search error:', err.name, err.message);
    return emptyResult;
  }
}

// Netlify function handler
export async function handler(event: { queryStringParameters?: Record<string, string> }) {
  const query = event.queryStringParameters?.query;

  if (!query) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Query parameter is required' }),
    };
  }

  try {
    const result = await searchMusicBrainz(query);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error('MusicBrainz endpoint error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
      }),
    };
  }
}
