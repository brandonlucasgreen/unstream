import type { MusicBrainzEnrichmentResponse, PlatformResult, SocialLink, SocialPlatform } from '../shared-types';
import { delay } from '../shared-utils';
import { fetchDiscogsSocialLinks, fetchOfficialSiteSocialLinks, mergeSocialLinks, parseSocialUrl } from '../social-links';

const USER_AGENT = 'Unstream/1.0 (https://github.com/unstream - ethical music finder)';
const MIN_SCORE = 95;
const MB_RATE_LIMIT_MS = 1100;

// Search MusicBrainz for major artists and return Hoopla/Freegal links if they have pre-2005 releases.
// Also extracts Bandcamp URLs from MB relations (primary source since Bandcamp scraping is blocked).
export async function searchMusicBrainz(query: string): Promise<PlatformResult[]> {
  const results: PlatformResult[] = [];

  try {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return results;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return results;

    const artist = artists[0];
    if (artist.score < MIN_SCORE) return results;

    await delay(MB_RATE_LIMIT_MS);

    // Fetch artist details with URL relations to extract Bandcamp links
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: { type: string; url?: { resource: string } }[];
      };

      const relations = artistData.relations || [];

      // Extract Bandcamp URLs from MB relations (bandcamp relation type or streaming music URLs)
      const platformRelTypes = new Set([
        'bandcamp', 'streaming music', 'purchase for download',
        'download for free', 'free streaming',
      ]);

      for (const rel of relations) {
        if (rel.url?.resource && platformRelTypes.has(rel.type)) {
          const url = rel.url.resource;
          // Only include *.bandcamp.com URLs (ignore other platforms)
          if (url.includes('.bandcamp.com')) {
            console.log(`[MusicBrainz] Found Bandcamp URL for "${artist.name}": ${url}`);
            results.push({
              sourceId: 'bandcamp',
              name: artist.name,
              type: 'artist',
              url,
            });
            break; // Only need one Bandcamp URL
          }
        }
      }
    }

    await delay(MB_RATE_LIMIT_MS);

    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!releasesResponse.ok) {
      console.log('MusicBrainz releases search failed:', releasesResponse.status);
      return results;
    }

    const releasesData = await releasesResponse.json() as { 'release-groups'?: { 'first-release-date'?: string }[] };
    const releaseGroups = releasesData['release-groups'] || [];

    for (const rg of releaseGroups) {
      const firstReleaseDate = rg['first-release-date'];
      if (firstReleaseDate) {
        const year = parseInt(firstReleaseDate.substring(0, 4), 10);
        if (year < 2005) {
          console.log('Adding Hoopla and Freegal for:', artist.name);
          const hooplaSearchUrl = `https://www.hoopladigital.com/search?q=${encodeURIComponent(artist.name)}&type=music`;
          results.push({
            sourceId: 'hoopla',
            name: artist.name,
            type: 'artist',
            url: hooplaSearchUrl,
          });
          const freegalArtistId = Buffer.from(artist.name).toString('base64');
          results.push({
            sourceId: 'freegal',
            name: artist.name,
            type: 'artist',
            url: `https://www.freegalmusic.com/artist/${freegalArtistId}`,
          });
          break;
        }
      }
    }
  } catch (error: any) {
    console.error('MusicBrainz search error:', error.name, error.message);
  }

  return results;
}

// MusicBrainz enrichment — official URL, Discogs, social links, pre-2005 release flag
export async function searchMusicBrainzEnrichment(query: string): Promise<MusicBrainzEnrichmentResponse> {
  const emptyResult: MusicBrainzEnrichmentResponse = {
    query,
    artistName: null,
    officialUrl: null,
    discogsUrl: null,
    hasPre2005Release: false,
    socialLinks: [],
  };

  try {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(query)}&fmt=json&limit=1`;

    const response = await globalThis.fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!response.ok) {
      console.log('MusicBrainz artist search failed:', response.status);
      return emptyResult;
    }

    const data = await response.json() as { artists?: { id: string; name: string; score: number }[] };
    const artists = data.artists || [];

    if (artists.length === 0) return emptyResult;

    const artist = artists[0];
    if (artist.score < MIN_SCORE) return emptyResult;

    await delay(MB_RATE_LIMIT_MS);

    const artistUrl = `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`;

    const artistResponse = await globalThis.fetch(artistUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    let officialUrl: string | null = null;
    let discogsUrl: string | null = null;
    const socialLinks: SocialLink[] = [];
    const seenPlatforms = new Set<SocialPlatform>();

    if (artistResponse.ok) {
      const artistData = await artistResponse.json() as {
        relations?: {
          type: string;
          url?: { resource: string };
        }[];
      };

      const relations = artistData.relations || [];

      for (const rel of relations) {
        if (rel.type === 'official homepage' && rel.url?.resource) {
          officialUrl = rel.url.resource;
          break;
        }
      }

      for (const rel of relations) {
        if (rel.type === 'discogs' && rel.url?.resource) {
          discogsUrl = rel.url.resource;
          break;
        }
      }

      for (const rel of relations) {
        if ((rel.type === 'social network' || rel.type === 'youtube') && rel.url?.resource) {
          const socialLink = parseSocialUrl(rel.url.resource);
          if (socialLink && !seenPlatforms.has(socialLink.platform)) {
            seenPlatforms.add(socialLink.platform);
            socialLinks.push(socialLink);
          }
        }
      }
    }

    await delay(MB_RATE_LIMIT_MS);

    const releasesUrl = `https://musicbrainz.org/ws/2/release-group/?artist=${artist.id}&fmt=json&limit=20`;

    const releasesResponse = await globalThis.fetch(releasesUrl, {
      headers: { 'User-Agent': USER_AGENT },
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

    const [discogsSocialLinks, officialSiteSocialLinks] = await Promise.all([
      discogsUrl ? fetchDiscogsSocialLinks(discogsUrl) : Promise.resolve([]),
      officialUrl ? fetchOfficialSiteSocialLinks(officialUrl) : Promise.resolve([]),
    ]);

    const allSocialLinks = mergeSocialLinks(socialLinks, discogsSocialLinks, officialSiteSocialLinks);

    return {
      query,
      artistName: artist.name,
      officialUrl,
      discogsUrl,
      hasPre2005Release,
      socialLinks: allSocialLinks,
    };
  } catch (error: any) {
    console.error('MusicBrainz enrichment error:', error.name, error.message);
    return emptyResult;
  }
}
