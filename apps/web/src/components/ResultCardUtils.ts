import type { SourceId, SearchResult, PlatformLink } from '../types';
import { sources, sourceCategories } from '../services/sources';
import type { CategorizedPlatforms } from './ResultCardTypes';

export function getSource(sourceId: SourceId) {
  return sources[sourceId] ?? sources['other'];
}

export function isDirectLink(url: string, sourceId: SourceId): boolean {
  if (!sources[sourceId]?.searchOnly) return true;
  const searchPatterns = ['/search', '?q=', '?query=', '/explore', 'duckduckgo.com'];
  return !searchPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

export function normalizeTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const typeIcon: Record<string, string> = {
  artist: '\uD83D\uDC64',
  album: '\uD83D\uDCBF',
  track: '\uD83C\uDFB5',
};

export const typeLabel: Record<string, string> = {
  artist: 'Artist',
  album: 'Album',
  track: 'Track',
};

export const allKnownSourceIds = new Set(
  Object.values(sourceCategories).flatMap(cat => cat.sources as SourceId[])
);

export function categorizePlatforms(
  platforms: PlatformLink[],
  allKnown: Set<SourceId>
): CategorizedPlatforms {
  return {
    marketplace: platforms.filter(p =>
      sourceCategories.marketplace.sources.includes(p.sourceId)
    ),
    patronage: platforms.filter(p =>
      sourceCategories.patronage.sources.includes(p.sourceId)
    ),
    library: platforms.filter(p =>
      sourceCategories.library.sources.includes(p.sourceId)
    ),
    decentralized: platforms.filter(p =>
      sourceCategories.decentralized.sources.includes(p.sourceId)
    ),
    official: platforms.filter(p =>
      sourceCategories.official.sources.includes(p.sourceId)
    ),
    social: platforms.filter(p =>
      sourceCategories.social.sources.includes(p.sourceId)
    ),
    curated: platforms.filter(p =>
      !allKnown.has(p.sourceId) || sourceCategories.curated.sources.includes(p.sourceId)
    ),
  };
}

/**
 * The links a card shows, in the order it shows them. Release verification uses the stricter
 * `getReleaseInfo().verifiedPlatforms`; display does not, because a search link to Ampwall,
 * Subvert, Ko-fi or Buy Me a Coffee is still a useful destination — it renders as a labelled
 * "Search Ampwall" action, never as a verified badge. Filtering them out here once left a
 * MusicBrainz-only fallback card with no destinations at all.
 *
 * The one exception is a Bandcamp search placeholder (`bandcamp.com/search?q=`): it claims a
 * presence nobody found, and the backend once stored and crawled those as artist pages (#407).
 *
 * Direct links come first, so a search action never sits ahead of a real page.
 */
export function getDisplayPlatforms(result: SearchResult): PlatformLink[] {
  const shown = result.platforms.filter(p =>
    p.sourceId !== 'bandcamp' || isDirectLink(p.url, p.sourceId)
  );
  const direct = shown.filter(p => isDirectLink(p.url, p.sourceId));
  const searches = shown.filter(p => !isDirectLink(p.url, p.sourceId));
  return [...direct, ...searches];
}

export interface ReleaseInfo {
  latestRelease: PlatformLink['latestRelease'];
  platformsWithRelease: PlatformLink[];
  canPlay: boolean;
  previewUrl: string | undefined;
}

export function getReleaseInfo(result: SearchResult): ReleaseInfo {
  const verifiedPlatforms = result.platforms.filter(p =>
    !getSource(p.sourceId)?.searchOnly || isDirectLink(p.url, p.sourceId)
  );

  const allPlatformsWithRelease = verifiedPlatforms
    .filter(p => p.latestRelease)
    .sort((a, b) => {
      if (a.sourceId === 'bandcamp' && b.sourceId !== 'bandcamp') return -1;
      if (a.sourceId !== 'bandcamp' && b.sourceId === 'bandcamp') return 1;
      return 0;
    });

  const latestRelease = allPlatformsWithRelease[0]?.latestRelease;
  const featuredTitle = latestRelease ? normalizeTitle(latestRelease.title) : '';

  const platformsWithRelease = allPlatformsWithRelease.filter(p => {
    if (!p.latestRelease || !featuredTitle) return false;
    const platformTitle = normalizeTitle(p.latestRelease.title);
    return platformTitle === featuredTitle ||
      platformTitle.includes(featuredTitle) ||
      featuredTitle.includes(platformTitle);
  });

  const bandcampWithRelease = platformsWithRelease.find(p => p.sourceId === 'bandcamp');
  const canPlay = !!bandcampWithRelease?.latestRelease;
  const previewUrl = bandcampWithRelease?.latestRelease?.url;

  return {
    latestRelease,
    platformsWithRelease,
    canPlay,
    previewUrl,
  };
}
