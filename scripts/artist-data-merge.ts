/**
 * How generate-artist-data.ts folds Phase 2 (MusicBrainz) data into Phase 1 search results.
 * Pure, so the identity rules can be unit-tested without the network.
 *
 * This is the generator's own merge, not the web client's mergeWithMusicBrainzData
 * (apps/web/src/services/sources.ts): that one imports the browser Sentry SDK and also builds
 * fallback cards, swaps in MusicBrainz's Bandcamp link and fills location and bio, none of
 * which the generator does. The two rules that decide *which* results get MusicBrainz's links
 * are the same in both, though, and must stay the same: the name match below and the
 * Bandcamp identity check from api/shared/bandcamp-identity.ts.
 */

import { bandcampSubdomainConflicts } from '../api/shared/bandcamp-identity';

export interface PlatformLink {
  sourceId: string;
  url: string;
  allReleaseTitles?: string[];
  latestRelease?: {
    title: string;
    type: string;
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
}

export interface SearchResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  matchConfidence?: 'verified' | 'unverified';
}

interface SocialLink {
  platform: string;
  url: string;
}

export interface MusicBrainzData {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
  /** The Bandcamp subdomain MusicBrainz says is this artist's. Null when it names none. */
  bandcampSubdomain?: string | null;
}

export function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a result's name is close enough to MusicBrainz's to be the same artist. Same rule
 * as the web client's merge: equal once normalized, or one containing the other with more
 * than 70% of its length ("National" / "The National"), so a short name can't match every
 * longer one that happens to contain it ("Chevy Chase" / "Chevy Chase Stole My Wife").
 */
function namesMatch(resultName: string, mbName: string): boolean {
  const resultNormalized = normalizeForComparison(resultName);
  const mbNormalized = normalizeForComparison(mbName);
  return (
    resultNormalized === mbNormalized ||
    (resultNormalized.includes(mbNormalized) && mbNormalized.length > resultNormalized.length * 0.7) ||
    (mbNormalized.includes(resultNormalized) && resultNormalized.length > mbNormalized.length * 0.7)
  );
}

export function mergeWithMusicBrainzData(results: SearchResult[], mbData: MusicBrainzData): SearchResult[] {
  if (!mbData.artistName) return results;
  const mbName = mbData.artistName;

  return results.map(result => {
    if (result.type !== 'artist') return result;
    if (!namesMatch(result.name, mbName)) return result;

    // Same name, different Bandcamp account: a homonym, not this artist. Merging would put
    // the MusicBrainz artist's official site and socials on a stranger's page — the
    // Honeycrush (Brooklyn) / Honey Crush (Orlando) case. Same rule as the server's
    // applyEnrichmentToResults and the web client's merge.
    const bandcampUrl = result.platforms.find(p => p.sourceId === 'bandcamp')?.url;
    if (bandcampSubdomainConflicts(mbData.bandcampSubdomain, bandcampUrl)) return result;

    const newPlatforms = [...result.platforms];

    if (mbData.officialUrl && !newPlatforms.some(p => p.sourceId === 'officialsite')) {
      newPlatforms.push({ sourceId: 'officialsite', url: mbData.officialUrl });
    }
    if (mbData.discogsUrl && !newPlatforms.some(p => p.sourceId === 'discogs')) {
      newPlatforms.push({ sourceId: 'discogs', url: mbData.discogsUrl });
    }
    if (mbData.hasPre2005Release) {
      if (!newPlatforms.some(p => p.sourceId === 'hoopla')) {
        newPlatforms.push({
          sourceId: 'hoopla',
          url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(result.name)}&type=music`,
        });
      }
      if (!newPlatforms.some(p => p.sourceId === 'freegal')) {
        newPlatforms.push({
          sourceId: 'freegal',
          url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(result.name)}`,
        });
      }
    }

    if (mbData.socialLinks && mbData.socialLinks.length > 0) {
      for (const social of mbData.socialLinks) {
        const existingIndex = newPlatforms.findIndex(p => p.sourceId === social.platform);
        if (existingIndex === -1) {
          newPlatforms.push({ sourceId: social.platform, url: social.url });
        } else {
          const existingUrl = newPlatforms[existingIndex].url.toLowerCase();
          const isSearchUrl = existingUrl.includes('duckduckgo.com') ||
            existingUrl.includes('/search') ||
            existingUrl.includes('?q=') ||
            existingUrl.includes('?query=') ||
            existingUrl.includes('/explore');
          if (isSearchUrl) {
            newPlatforms[existingIndex] = { sourceId: social.platform, url: social.url };
          }
        }
      }
    }

    // Sort platforms
    const searchOnlyPlatforms = new Set(['ampwall', 'kofi', 'buymeacoffee']);
    const officialPlatforms = new Set(['officialsite', 'discogs', 'hoopla', 'freegal']);
    const socialPlatforms = new Set(['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'peertube']);
    newPlatforms.sort((a, b) => {
      const aIsSocial = socialPlatforms.has(a.sourceId);
      const bIsSocial = socialPlatforms.has(b.sourceId);
      if (aIsSocial && !bIsSocial) return 1;
      if (!aIsSocial && bIsSocial) return -1;
      if (aIsSocial && bIsSocial) {
        const order = ['instagram', 'tiktok', 'youtube', 'peertube', 'threads', 'bluesky', 'mastodon', 'facebook'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }
      const aIsOfficial = officialPlatforms.has(a.sourceId);
      const bIsOfficial = officialPlatforms.has(b.sourceId);
      if (aIsOfficial && bIsOfficial) {
        const order = ['officialsite', 'discogs', 'hoopla', 'freegal'];
        return order.indexOf(a.sourceId) - order.indexOf(b.sourceId);
      }
      if (aIsOfficial) return 1;
      if (bIsOfficial) return -1;
      const aIsSearchOnly = searchOnlyPlatforms.has(a.sourceId);
      const bIsSearchOnly = searchOnlyPlatforms.has(b.sourceId);
      if (aIsSearchOnly && !bIsSearchOnly) return 1;
      if (!aIsSearchOnly && bIsSearchOnly) return -1;
      return 0;
    });

    return { ...result, platforms: newPlatforms };
  });
}
