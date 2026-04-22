import { parse } from 'node-html-parser';
import type { LatestRelease, PlatformResult } from '../shared-types';
import { fetchWithTimeout, normalizeForComparison } from '../shared-utils';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Search Bandcamp by scraping search results page (PRIMARY SOURCE)
export async function searchBandcamp(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];
  const searchUrl = `https://bandcamp.com/search?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    }, 5000);

    if (!response.ok) {
      console.error('Bandcamp search failed:', response.status);
      return results;
    }

    const html = await response.text();
    const root = parse(html);

    const resultItems = root.querySelectorAll('.searchresult');

    for (let i = 0; i < Math.min(10, resultItems.length); i++) {
      const item = resultItems[i];
      const resultType = item.querySelector('.result-info .itemtype')?.textContent?.trim().toLowerCase();
      const heading = item.querySelector('.result-info .heading a');
      const name = heading?.textContent?.trim();
      const url = heading?.getAttribute('href')?.split('?')[0];

      const subhead = item.querySelector('.result-info .subhead')?.textContent?.trim();
      let artist: string | undefined;
      if (subhead && subhead.startsWith('by ')) {
        artist = subhead.substring(3).trim();
      }

      const img = item.querySelector('.art img');
      const imageUrl = img?.getAttribute('src');

      if (name && url) {
        let type: 'artist' | 'album' | 'track' = 'artist';
        if (resultType === 'album') type = 'album';
        else if (resultType === 'track') type = 'track';

        results.push({
          sourceId: 'bandcamp',
          name,
          artist,
          type,
          url,
          imageUrl: imageUrl || undefined,
        });
      }
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('Bandcamp search timed out');
    } else {
      console.error('Bandcamp search error:', error.message);
    }
  }

  return results;
}

// Fetch latest release from a Bandcamp artist page, then get release date from album page.
// Uses /music endpoint to get full discography (base URL may redirect to a single release).
export async function getBandcampLatestRelease(artistUrl: string): Promise<LatestRelease | undefined> {
  try {
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: { 'User-Agent': USER_AGENT },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();
    const root = parse(html);

    const musicGridItem = root.querySelector('.music-grid-item');
    if (!musicGridItem) return undefined;

    const link = musicGridItem.querySelector('a');
    const titleEl = musicGridItem.querySelector('.title');
    const artImg = musicGridItem.querySelector('img');

    if (!link || !titleEl) return undefined;

    const href = link.getAttribute('href');
    const title = titleEl.textContent?.trim();
    const imageUrl = artImg?.getAttribute('src') || artImg?.getAttribute('data-original');

    if (!href || !title) return undefined;

    const type: 'album' | 'track' = href.includes('/track/') ? 'track' : 'album';
    const fullUrl = href.startsWith('http') ? href : new URL(href, artistUrl).toString();

    // Fetch the album/track page for release date
    let releaseDate: string | undefined;
    try {
      const albumResponse = await fetchWithTimeout(fullUrl, {
        headers: { 'User-Agent': USER_AGENT },
      }, 3000);

      if (albumResponse.ok) {
        const albumHtml = await albumResponse.text();
        const dateMatch = albumHtml.match(/released\s+(\w+\s+\d+,\s+\d{4})/i) ||
                          albumHtml.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})"/);
        if (dateMatch) {
          releaseDate = dateMatch[1];
        }
      }
    } catch {
      // ignore
    }

    return {
      title,
      type,
      url: fullUrl,
      imageUrl: imageUrl || undefined,
      releaseDate,
    };
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Bandcamp latest release fetch error:', error.message);
    }
    return undefined;
  }
}

// Search a Bandcamp artist page for a specific album title.
// Uses /music endpoint to access full discography (base URL may redirect to a single release).
export async function searchBandcampForAlbum(artistUrl: string, albumTitle: string): Promise<string | undefined> {
  try {
    const baseUrl = artistUrl.replace(/\/(music|album|track).*$/, '');
    const musicUrl = `${baseUrl}/music`;

    const response = await fetchWithTimeout(musicUrl, {
      headers: { 'User-Agent': USER_AGENT },
    }, 3000);

    if (!response.ok) return undefined;

    const html = await response.text();
    const root = parse(html);
    const normalizedSearchTitle = normalizeForComparison(albumTitle);

    const musicGridItems = root.querySelectorAll('.music-grid-item');
    for (const item of musicGridItems) {
      const titleEl = item.querySelector('.title');
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      const normalizedTitle = normalizeForComparison(title);
      if (normalizedTitle === normalizedSearchTitle ||
          normalizedTitle.includes(normalizedSearchTitle) ||
          normalizedSearchTitle.includes(normalizedTitle)) {
        const link = item.querySelector('a');
        const href = link?.getAttribute('href');
        if (href) {
          return href.startsWith('http') ? href : new URL(href, artistUrl).toString();
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Fetch Bandcamp embed data for an artist, album, or track URL
export async function getBandcampEmbed(url: string): Promise<{ embedUrl: string; title: string } | null> {
  try {
    const isAlbumUrl = url.includes('/album/');
    const isTrackUrl = url.includes('/track/');

    const response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT },
    }, 5000);

    if (!response.ok) return null;

    const html = await response.text();

    // Album or track page: extract ID directly
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

    // Artist page: look for album or track links
    const albumMatch = html.match(/href="(\/album\/[^"]+)"/);
    const trackMatch = html.match(/href="(\/track\/[^"]+)"/);

    const itemPath = albumMatch?.[1] || trackMatch?.[1];
    const itemType: 'album' | 'track' = albumMatch ? 'album' : 'track';

    if (!itemPath) {
      // Single-track artist page
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
      headers: { 'User-Agent': USER_AGENT },
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
