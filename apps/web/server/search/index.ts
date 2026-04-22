import type { AggregatedResult, PlatformResult } from '../shared-types';
import { generateResultId, normalizeForComparison, parseReleaseDate, textMatchScore } from '../shared-utils';
import { getBandcampLatestRelease, searchBandcamp, searchBandcampForAlbum } from './bandcamp';
import { searchBandwagon } from './bandwagon';
import { searchBeatport } from './beatport';
import { searchEven } from './even';
import { searchFaircamp } from './faircamp';
import { searchMirlo } from './mirlo';
import { searchMusicBrainz } from './musicbrainz';
import { searchPatreon } from './patreon';
import { getQobuzLatestRelease, searchQobuz } from './qobuz';

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

export async function searchAllPlatforms(query: string): Promise<AggregatedResult[]> {
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

  const bandwagonMatches = bandwagonResults.status === 'fulfilled' ? bandwagonResults.value : new Map<string, string>();
  const faircampMatches = faircampResults.status === 'fulfilled' ? faircampResults.value : new Map<string, string>();
  const patreonMatches = patreonResults.status === 'fulfilled' ? patreonResults.value : new Map<string, string>();
  const qobuzMatches = qobuzResults.status === 'fulfilled' ? qobuzResults.value : new Map<string, string>();
  const beatportMatches = beatportResults.status === 'fulfilled' ? beatportResults.value : new Map<string, string>();
  const evenMatches = evenResults.status === 'fulfilled' ? evenResults.value : new Map<string, string>();

  const aggregated = aggregateResults(allResults, query);

  // Add additional platforms to matching artist results
  for (const result of aggregated) {
    if (result.type === 'artist') {
      // Search-only platform links for artists found on Bandcamp
      if (result.platforms.some(p => p.sourceId === 'bandcamp')) {
        result.platforms.push({
          sourceId: 'ampwall',
          url: `https://ampwall.com/explore?searchStyle=search&query=${encodeURIComponent(result.name)}`,
        });
        // Ko-fi (DuckDuckGo site search since Ko-fi has no native search)
        result.platforms.push({
          sourceId: 'kofi',
          url: `https://duckduckgo.com/?q=site:ko-fi.com+${encodeURIComponent(result.name)}`,
        });
        // Buy Me a Coffee has no query search, link to explore
        result.platforms.push({
          sourceId: 'buymeacoffee',
          url: 'https://buymeacoffee.com/explore-creators',
        });
      }

      const normalizedName = normalizeForComparison(result.name);

      if (bandwagonMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'bandwagon', url: bandwagonMatches.get(normalizedName)! });
      }
      if (faircampMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'faircamp', url: faircampMatches.get(normalizedName)! });
      }
      if (patreonMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'patreon', url: patreonMatches.get(normalizedName)! });
      }
      if (qobuzMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'qobuz', url: qobuzMatches.get(normalizedName)! });
      }
      if (beatportMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'beatport', url: beatportMatches.get(normalizedName)! });
      }
      if (evenMatches.has(normalizedName)) {
        result.platforms.push({ sourceId: 'even', url: evenMatches.get(normalizedName)! });
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
            if (release) bandcampPlatform.latestRelease = release;
          })
        );
      }

      const qobuzPlatform = result.platforms.find(p => p.sourceId === 'qobuz');
      if (qobuzPlatform) {
        releasePromises.push(
          getQobuzLatestRelease(qobuzPlatform.url).then(release => {
            if (release) qobuzPlatform.latestRelease = release;
          })
        );
      }
    }
  }

  await Promise.race([
    Promise.allSettled(releasePromises),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);

  // For each result, find the most recent release; only keep platforms with that same release
  for (const result of aggregated) {
    const platformsWithReleases = result.platforms.filter(p => p.latestRelease);
    if (platformsWithReleases.length === 0) continue;

    const releasesWithDates = platformsWithReleases.map(p => ({
      platform: p,
      date: parseReleaseDate(p.latestRelease?.releaseDate),
      normalizedTitle: normalizeForComparison(p.latestRelease?.title || ''),
    }));

    releasesWithDates.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

    const mostRecent = releasesWithDates[0];
    if (!mostRecent?.normalizedTitle) continue;

    const mostRecentTitle = mostRecent.normalizedTitle;
    const winningRelease = mostRecent.platform.latestRelease!;

    const searchPromises: Promise<void>[] = [];
    for (const platform of result.platforms) {
      if (platform.latestRelease) {
        const normalizedTitle = normalizeForComparison(platform.latestRelease.title);
        if (normalizedTitle !== mostRecentTitle) {
          // Platform has a different release — try to find the winning release
          if (platform.sourceId === 'bandcamp') {
            searchPromises.push(
              searchBandcampForAlbum(platform.url, winningRelease.title).then(albumUrl => {
                if (albumUrl) {
                  platform.latestRelease = { ...winningRelease, url: albumUrl };
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

    if (searchPromises.length > 0) {
      await Promise.allSettled(searchPromises);
    }
  }

  return aggregated;
}
