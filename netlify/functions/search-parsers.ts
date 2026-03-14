// Pure HTML parsing functions extracted from search-sources.ts for testability.
// These contain no I/O — they take HTML strings and return structured results.

import { parse } from 'node-html-parser';
import {
  type PlatformResult,
  normalizeForComparison,
  namesMatch,
} from './search-utils';

// ---------------------------------------------------------------------------
// Bandcamp
// ---------------------------------------------------------------------------

/** Parse Bandcamp search results HTML into PlatformResult[] */
export function parseBandcampSearchResults(html: string, query: string): PlatformResult[] {
  const results: PlatformResult[] = [];
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

      // Filter: only include results where name matches the query
      const nameToCheck = type === 'artist' ? name : (artist || name);
      if (!namesMatch(nameToCheck, query)) continue;

      // Filter out fan profiles: bandcamp.com/username (path-based)
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.hostname === 'bandcamp.com') continue;
      } catch { /* invalid URL, skip */ }

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

  return results;
}

// ---------------------------------------------------------------------------
// Mirlo
// ---------------------------------------------------------------------------

/** Parse a Mirlo artist page HTML to determine if the artist exists */
export function parseMirloArtistPage(html: string, normalizedQuery: string, artistUrl: string): PlatformResult | null {
  const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (!ogTitleMatch) return null;

  const ogTitle = ogTitleMatch[1].toLowerCase();
  // If og:title is just "Mirlo", the artist doesn't exist
  if (ogTitle === 'mirlo') return null;
  if (!ogTitle.includes(normalizedQuery.substring(0, 4))) return null;

  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const imageUrl = ogImageMatch ? ogImageMatch[1] : undefined;

  return {
    sourceId: 'mirlo',
    name: ogTitleMatch[1],
    type: 'artist',
    url: artistUrl,
    imageUrl,
  };
}

// ---------------------------------------------------------------------------
// Qobuz
// ---------------------------------------------------------------------------

/** Parse Qobuz search page HTML to extract artist interpreter links */
export function parseQobuzSearchResults(html: string, query: string): [string, string][] {
  const results: [string, string][] = [];
  const interpreterRegex = /href="(\/us-en\/interpreter\/([^/]+)\/(\d+))"/g;
  let match;
  const queryNormalized = normalizeForComparison(query);
  const seen = new Set<string>();

  while ((match = interpreterRegex.exec(html)) !== null && results.length < 10) {
    const [, path, slug] = match;
    const slugNormalized = slug.replace(/-/g, '');

    const isMatch = slugNormalized === queryNormalized ||
        queryNormalized.startsWith(slugNormalized) ||
        (slugNormalized.startsWith(queryNormalized) && /^\d*$/.test(slugNormalized.slice(queryNormalized.length)));

    if (isMatch) {
      const artistName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const normalizedName = normalizeForComparison(artistName);

      if (!seen.has(normalizedName)) {
        seen.add(normalizedName);
        results.push([normalizedName, `https://www.qobuz.com${path}`]);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Bandcamp releases
// ---------------------------------------------------------------------------

/** Parse Bandcamp /music page HTML to extract release titles */
export function parseBandcampReleaseTitles(html: string): string[] {
  const root = parse(html);
  const titles: string[] = [];
  const musicGridItems = root.querySelectorAll('.music-grid-item');

  for (const item of musicGridItems) {
    const titleEl = item.querySelector('.title');
    const title = titleEl?.textContent?.trim();
    if (title) {
      titles.push(normalizeForComparison(title));
    }
    if (titles.length >= 20) break;
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Bandwagon
// ---------------------------------------------------------------------------

/** Parse Bandwagon search results HTML to extract artist links */
export function parseBandwagonSearchResults(html: string, query: string): Map<string, string> {
  const results = new Map<string, string>();
  const root = parse(html);
  const queryNormalized = normalizeForComparison(query);

  const artistLinks = root.querySelectorAll('a[href*="bandwagon.fm/@"]');
  const seen = new Set<string>();

  for (const link of artistLinks) {
    const href = link.getAttribute('href');
    const nameEl = link.querySelector('.bold');
    const name = nameEl?.textContent?.trim();

    if (href && name && !seen.has(href) && name.length > 0 && name.length < 100) {
      seen.add(href);
      const normalizedName = normalizeForComparison(name);

      if (normalizedName === queryNormalized ||
          normalizedName.includes(queryNormalized) ||
          queryNormalized.includes(normalizedName)) {
        if (!results.has(normalizedName)) {
          results.set(normalizedName, href);
        }
        if (results.size >= 10) break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Jam.coop
// ---------------------------------------------------------------------------

/** Parse Jam.coop artists directory HTML to build a name→URL map */
export function parseJamcoopDirectory(html: string): Map<string, { name: string; url: string }> {
  const root = parse(html);
  const directory = new Map<string, { name: string; url: string }>();

  const artistLinks = root.querySelectorAll('a[href^="/artists/"]');

  for (const link of artistLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/artists') continue;

    const name = link.textContent?.trim();
    if (!name) continue;

    const normalizedName = normalizeForComparison(name);
    if (normalizedName && !directory.has(normalizedName)) {
      directory.set(normalizedName, {
        name,
        url: `https://jam.coop${href}`,
      });
    }
  }

  return directory;
}

// ---------------------------------------------------------------------------
// Faircamp
// ---------------------------------------------------------------------------

/** Parse Faircamp page HTML to extract release titles */
export function parseFaircampReleaseTitles(html: string): string[] {
  const root = parse(html);
  const titles: string[] = [];

  const releases = root.querySelectorAll('.release');
  for (const release of releases) {
    const links = release.querySelectorAll('a');
    if (links.length >= 2) {
      const title = links[1].textContent?.trim();
      if (title) titles.push(normalizeForComparison(title));
    }
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Patreon
// ---------------------------------------------------------------------------

/** Parse Patreon search API JSON response into name→URL pairs */
export function parsePatreonSearchResults(data: {
  data?: {
    type: string;
    attributes?: {
      creator_name?: string;
      url?: string;
    };
  }[];
}): [string, string][] {
  const results: [string, string][] = [];
  const seen = new Set<string>();
  const campaigns = data.data || [];

  for (const campaign of campaigns) {
    if (campaign.type === 'campaign-document' && campaign.attributes) {
      const creatorName = campaign.attributes.creator_name;
      const url = campaign.attributes.url;

      if (creatorName && url) {
        const normalizedName = normalizeForComparison(creatorName);
        if (!seen.has(normalizedName)) {
          seen.add(normalizedName);
          results.push([normalizedName, url]);
        }
        const urlSlug = url.split('/').pop();
        if (urlSlug) {
          const normalizedSlug = normalizeForComparison(urlSlug);
          if (!seen.has(normalizedSlug)) {
            seen.add(normalizedSlug);
            results.push([normalizedSlug, url]);
          }
        }
      }
    }
    if (results.length >= 20) break;
  }

  return results;
}
