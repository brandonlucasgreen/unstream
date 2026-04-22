import type { IncomingMessage, ServerResponse } from 'http';
import type { AggregatedResult, PlatformResult, SourceId } from './shared-types';

// Import search functions from search-engines.ts
import {
  searchBandcamp,
  searchBandcampForAlbum,
  getBandcampLatestRelease,
  searchBandwagon,
  searchMusicBrainz,
  searchMusicBrainzEnrichment,
  searchMirlo,
  searchFaircamp,
  searchPatreon,
  searchQobuz,
  searchBeatport,
  searchEven,
  getQobuzLatestRelease,
} from './search-engines';

// Import shared utilities
import { fetchWithTimeout, normalizeForComparison, generateResultId, textMatchScore, parseReleaseDate } from './shared-utils';

// Import social links functions (used in search-musicbrainz)
// mergeSocialLinks is used by search-engines internally

// Aggregate results from multiple platforms
function aggregateResults(allResults: PlatformResult[], query?: string): AggregatedResult[] {
  const resultMap = new Map<string, AggregatedResult>();

  for (const result of allResults) {
    const key = generateResultId(result.name, result.artist);

    if (resultMap.has(key)) {
      const existing = resultMap.get(key)!;
      if (!existing.platforms.some(p => p.sourceId === result.sourceId)) {
        existing.platforms.push({
          sourceId: result.sourceId,
          url: result.url,
        });
      }
      if (!existing.imageUrl && result.imageUrl) {
        existing.imageUrl = result.imageUrl;
      }
    } else {
      resultMap.set(key, {
        id: key,
        name: result.name,
        artist: result.artist,
        type: result.type,
        imageUrl: result.imageUrl,
        platforms: [{
          sourceId: result.sourceId,
          url: result.url,
        }],
      });
    }
  }

  return Array.from(resultMap.values())
    .sort((a, b) => {
      if (query) {
        const scoreA = textMatchScore(a.name, query);
        const scoreB = textMatchScore(b.name, query);
        if (scoreA !== scoreB) return scoreB - scoreA;
      }
      return b.platforms.length - a.platforms.length;
    });
}

// Send JSON response
function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Main API handler
export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) {
    return false;
  }

  if (url.pathname === '/api/search/sources') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const results = await searchAllPlatforms(query);
      sendJson(res, 200, { query, results, hasPendingEnrichment: results.length > 0 });
    } catch (error) {
      console.error('Search error:', error);
      sendJson(res, 500, { error: 'Failed to search', query, results: [] });
    }
    return true;
  }

  if (url.pathname === '/api/search/musicbrainz') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const result = await searchMusicBrainzEnrichment(query);
      sendJson(res, 200, result);
    } catch (error) {
      console.error('MusicBrainz enrichment error:', error);
      sendJson(res, 500, {
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
        socialLinks: [],
      });
    }
    return true;
  }

  if (url.pathname === '/api/embed/bandcamp') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const artistUrl = url.searchParams.get('url');

    if (!artistUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const embedData = await getBandcampEmbed(artistUrl);
      if (embedData) {
        sendJson(res, 200, embedData);
      } else {
        sendJson(res, 404, { error: 'Could not find embeddable content' });
      }
    } catch (error) {
      console.error('Embed error:', error);
      sendJson(res, 500, { error: 'Failed to fetch embed data' });
    }
    return true;
  }

  if (url.pathname === '/api/resolve/url') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const streamingUrl = url.searchParams.get('url');

    if (!streamingUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const result = await resolveStreamingUrl(streamingUrl);
      if (result) {
        sendJson(res, 200, result);
      } else {
        sendJson(res, 404, { error: 'Could not resolve artist from URL' });
      }
    } catch (error) {
      console.error('Resolve error:', error);
      sendJson(res, 500, { error: 'Failed to resolve URL' });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

// Fetch Bandcamp embed data for an artist, album, or track URL
async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!response.ok) return null;

    const html = await response.text();

    if (isAlbumUrl || isTrackUrl) {
      const itemType = isAlbumUrl ? 'album' : 'track';

      const embeddableMatch = html.match(/"public_embeddable":(true|false)/);
      if (embeddableMatch && embeddableMatch[1] === 'false') {
        console.log('Bandcamp content is not publicly embeddable');
        return null;
      }

      const tralbumMatch = html.match(/"tralbum_param":\s*\{\s*"name"\s*:\s*"(album|track)"\s*,\s*"value"\s*:\s*(\d+)\s*\}/);
      const directMatch = html.match(new RegExp(`${itemType}=(\\d+)`));
      const dataMatch = html.match(new RegExp(`data-${itemType}-id="(\\d+)"`));
      const jsonMatch = html.match(new RegExp(`"${itemType}_id"\\s*:\\s*(\\d+)`));
      const currentIdMatch = html.match(/"current"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);

      const idMatch = tralbumMatch || directMatch || dataMatch || jsonMatch || currentIdMatch;
      if (!idMatch) return null;

      const itemId = tralbumMatch ? tralbumMatch[2] : idMatch[1];

      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

      return {
        embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
        title,
      };
    }

    const albumMatch = html.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = html.match(/href="(\/track\/[^"]+)"/);

    let itemPath = albumMatch?.[1] || trackMatch?.[1];
    let itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    if (!itemPath) {
      const trackIdMatch = html.match(/data-item-id="track-(\d+)"/);
      if (trackIdMatch) {
        const trackId = trackIdMatch[1];
        return {
          embedUrl: `https://bandcamp.com/EmbeddedPlayer/track=${trackId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
          title: 'Track',
        };
      }
      return null;
    }

    const baseUrl = url.replace(/\/$/, '').replace(/\/music$/, '');
    const itemUrl = baseUrl + itemPath;

    const itemResponse = await fetchWithTimeout(itemUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, 5000);

    if (!itemResponse.ok) return null;

    const itemHtml = await itemResponse.text();

    const idMatch = itemHtml.match(new RegExp(`${itemType}=(\\d+)`));
    if (!idMatch) return null;

    const itemId = idMatch[1];

    const titleMatch = itemHtml.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.split('|')[0]?.trim() || 'Music';

    return {
      embedUrl: `https://bandcamp.com/EmbeddedPlayer/${itemType}=${itemId}/size=small/bgcol=ffffff/linkcol=0687f5/transparent=true/`,
      title,
    };
  } catch (error: any) {
    console.error('Bandcamp embed error:', error.message);
    return null;
  }
}

// Resolve artist name from Spotify or Apple Music URL
async function resolveStreamingUrl(url: string): Promise<{ artistName: string; source: 'spotify' | 'apple' } | null> {
  try {
    if (url.startsWith('spotify:')) {
      const parts = url.split(':');
      if (parts.length >= 3) {
        url = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      }
    }

    const spotifyMatch = url.match(/open\.spotify\.com\/(artist|album|track)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
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
        const descMatch = html.match(/<meta\s+property="og:description"\s+content="[^"]*(?:by|from)\s+([^"·]+)/i) ||
                         html.match(/<meta\s+content="[^"]*(?:by|from)\s+([^"·]+)"\s+property="og:description"/i);
        if (descMatch) {
          return { artistName: descMatch[1].trim(), source: 'spotify' };
        }

        const artistLinkMatch = html.match(/href="\/artist\/[^"]+">([^<]+)<\/a>/);
        if (artistLinkMatch) {
          return { artistName: artistLinkMatch[1].trim(), source: 'spotify' };
        }

        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const parts = titleMatch[1].split(/\s*[-–—]\s*/);
          if (parts.length >= 2) {
            let artist = parts[1].replace(/\s*[-–—]\s*Spotify.*$/i, '').trim();
            if (artist && artist.toLowerCase() !== 'spotify') {
              return { artistName: artist, source: 'spotify' };
            }
          }
        }
      }

      return null;
    }

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

      if (type === 'artist') {
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                          html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);
        if (titleMatch) {
          const artistName = titleMatch[1]
            .replace(/\s*[-–—]\s*Apple Music.*$/i, '')
            .replace(/\s+on Apple Music.*$/i, '')
            .trim();
          return { artistName, source: 'apple' };
        }
      } else {
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



// Search all platforms
async function searchAllPlatforms(query: string): Promise<AggregatedResult[]> {
  const [bandcampResults, bandwagonResults, mirloResults, faircampResults, patreonResults, qobuzResults, musicbrainzResults, beatportResults, evenResults] = await Promise.allSettled([
    searchBandcamp(query),
    searchBandwagon(query),
    searchMirlo(query),
    searchFaircamp(query),
    searchPatreon(query),
    searchQobuz(query),
    searchMusicBrainz(query),
    searchBeatport(query),
    searchEven(query),
  ]);

  const allResults: PlatformResult[] = [];

  if (bandcampResults.status === 'fulfilled') {
    allResults.push(...bandcampResults.value.filter(r => r.type === 'artist'));
  }
  if (mirloResults.status === 'fulfilled') {
    allResults.push(...mirloResults.value.filter(r => r.type === 'artist'));
  }
  if (musicbrainzResults.status === 'fulfilled') {
    allResults.push(...musicbrainzResults.value.filter(r => r.type === 'artist'));
  }

  // Get matches from other platforms
  const bandwagonMatches = bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map<string, string>();
  const faircampMatches = faircampResults.status === 'fulfilled' ? faircampResults.value : new Map<string, string>();
  const patreonMatches = patreonResults.status === 'fulfilled' ? patreonResults.value : new Map<string, string>();
  const qobuzMatches = qobuzResults.status === 'fulfilled' ? qobuzResults.value : new Map<string, string>();
  const beatportMatches = beatportResults.status === 'fulfilled' ? beatportResults.value : new Map<string, string>();
  const evenMatches = evenResults.status === 'fulfilled' ? evenResults.value : new Map<string, string>();

  // Get aggregated results
  const aggregated = aggregateResults(allResults, query);

  // Add additional platforms to matching artist results
  for (const result of aggregated) {
    if (result.type === 'artist') {
      const normalizedName = normalizeForComparison(result.name);

      if (bandwagonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'bandwagon' as SourceId,
          url: bandwagonMatches.get(normalizedName)!,
        });
      }

      if (faircampMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'faircamp' as SourceId,
          url: faircampMatches.get(normalizedName)!,
        });
      }

      if (patreonMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'patreon' as SourceId,
          url: patreonMatches.get(normalizedName)!,
        });
      }

      if (qobuzMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'qobuz' as SourceId,
          url: qobuzMatches.get(normalizedName)!,
        });
      }

      if (beatportMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'beatport' as SourceId,
          url: beatportMatches.get(normalizedName)!,
        });
      }

      if (evenMatches.has(normalizedName)) {
        result.platforms.push({
          sourceId: 'even' as SourceId,
          url: evenMatches.get(normalizedName)!,
        });
      }

      // Sort platforms: verified matches first, search-only platforms last
      const searchOnlyPlatforms = new Set(['ampwall', 'kofi', 'buymeacoffee']);
      result.platforms.sort((a, b) => {
        const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
        const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
        if (aIsSearchOnly && !bIsSearchOnly) return 1;
        if (!aIsSearchOnly && bIsSearchOnly) return -1;
        return 0;
      });
    }
  }

  // Fetch latest releases for Bandcamp and Qobuz artist pages in parallel
  const releasePromises: Promise<void>[] = [];
  for (const result of aggregated) {
    if (result.type === 'artist') {
      const bandcampPlatform = result.platforms.find(p => p.sourceId === 'bandcamp');
      if (bandcampPlatform) {
        releasePromises.push(
          getBandcampLatestRelease(bandcampPlatform.url).then(release => {
            if (release) {
              bandcampPlatform.latestRelease = release;
            }
          })
        );
      }

      const qobuzPlatform = result.platforms.find(p => p.sourceId === 'qobuz');
      if (qobuzPlatform) {
        releasePromises.push(
          getQobuzLatestRelease(qobuzPlatform.url).then(release => {
            if (release) {
              qobuzPlatform.latestRelease = release;
            }
          })
        );
      }
    }
  }

  // Wait for all release fetches with a timeout
  await Promise.race([
    Promise.allSettled(releasePromises),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);

  // For each result, find the most recent release and only keep platforms with that same release
  for (const result of aggregated) {
    const platformsWithReleases = result.platforms.filter(p => p.latestRelease);
    if (platformsWithReleases.length === 0) continue;

    // Parse dates and find the most recent
    const releasesWithDates = platformsWithReleases.map(p => ({
      platform: p,
      date: parseReleaseDate(p.latestRelease?.releaseDate),
      normalizedTitle: normalizeForComparison(p.latestRelease?.title || ''),
    }));

    // Sort by date descending (most recent first)
    releasesWithDates.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

    // Get the most recent release
    const mostRecent = releasesWithDates[0];
    if (!mostRecent?.normalizedTitle) continue;

    const mostRecentTitle = mostRecent.normalizedTitle;
    const winningRelease = mostRecent.platform.latestRelease!;

    // For platforms that have a different "latest", try to find the winning release on them
    const searchPromises: Promise<void>[] = [];
    for (const platform of result.platforms) {
      if (platform.latestRelease) {
        const normalizedTitle = normalizeForComparison(platform.latestRelease.title);
        if (normalizedTitle !== mostRecentTitle) {
          if (platform.sourceId === 'bandcamp') {
            searchPromises.push(
              searchBandcampForAlbum(platform.url, winningRelease.title).then(albumUrl => {
                if (albumUrl) {
                  platform.latestRelease = {
                    ...winningRelease,
                    url: albumUrl,
                  };
                } else {
                  platform.latestRelease = undefined;
                }
              })
            );
          } else {
            platform.latestRelease = undefined;
          }
        }
      }
    }

    // Wait for album searches
    if (searchPromises.length > 0) {
      await Promise.allSettled(searchPromises);
    }
  }

  return aggregated;
}
