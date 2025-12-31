import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcfetch from 'bandcamp-fetch';

interface BandcampResult {
  found: boolean;
  results: {
    type: 'artist' | 'album' | 'track';
    name: string;
    url: string;
    imageUrl?: string;
    artist?: string;
  }[];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { query, type } = req.query;

  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Query parameter is required' });
    return;
  }

  try {
    const searchType = type as string || 'all';
    const results: BandcampResult['results'] = [];

    // Search based on type
    if (searchType === 'all' || searchType === 'artist') {
      const artistResults = await bcfetch.search.artistsAndLabels({ query, limit: 5 });
      for (const artist of artistResults.items || []) {
        results.push({
          type: 'artist',
          name: artist.name,
          url: artist.url,
          imageUrl: artist.imageUrl,
        });
      }
    }

    if (searchType === 'all' || searchType === 'album') {
      const albumResults = await bcfetch.search.albums({ query, limit: 5 });
      for (const album of albumResults.items || []) {
        results.push({
          type: 'album',
          name: album.name,
          url: album.url,
          imageUrl: album.imageUrl,
          artist: album.artist,
        });
      }
    }

    if (searchType === 'all' || searchType === 'track') {
      const trackResults = await bcfetch.search.tracks({ query, limit: 5 });
      for (const track of trackResults.items || []) {
        results.push({
          type: 'track',
          name: track.name,
          url: track.url,
          imageUrl: track.imageUrl,
          artist: track.artist,
        });
      }
    }

    const response: BandcampResult = {
      found: results.length > 0,
      results,
    };

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    res.status(200).json(response);
  } catch (error) {
    console.error('Bandcamp search error:', error);
    res.status(500).json({
      error: 'Failed to search Bandcamp',
      found: false,
      results: []
    });
  }
}
