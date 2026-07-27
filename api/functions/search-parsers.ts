// Pure HTML parsing functions extracted from search-sources.ts for testability.
// These contain no I/O — they take HTML strings and return structured results.

import { parse, type HTMLElement } from 'node-html-parser';
import {
  type PlatformResult,
  normalizeForComparison,
  namesMatch,
  displayNameFromSlug,
} from './search-utils';

// ---------------------------------------------------------------------------
// Bandcamp
// ---------------------------------------------------------------------------

/**
 * True if this HTML is a Fastly bot-challenge interstitial rather than real content.
 *
 * Bandcamp serves the challenge with HTTP 200, so an `!response.ok` check never
 * catches it. Without this, a challenge parses to zero results and is
 * indistinguishable from "the artist genuinely isn't on Bandcamp" — a wrong
 * confident answer rather than a visible failure.
 *
 * Fastly's challenge page loads its assets from a `/_fs-ch-<token>/` path and
 * carries a restrictive inline CSP; the asset path is the stable marker.
 */
export function isBandcampChallenge(html: string): boolean {
  if (!html) return false;
  // Challenge pages are small; real Bandcamp pages are 100KB+. Cheap pre-filter.
  if (html.length > 20_000) return false;
  return html.includes('/_fs-ch-');
}

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
      const artistName = displayNameFromSlug(slug, query);
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

/**
 * Read a Bandcamp page's own claim about which band it belongs to.
 *
 * Every Bandcamp page carries `data-band="{"id":...,"name":"..."}"`. This is the
 * authoritative identity check when probing a guessed subdomain — a slug
 * existing does not mean it is the right artist. `thebeths.bandcamp.com`
 * resolves but is an unrelated account named "no content".
 */
export function parseBandcampBandIdentity(html: string): { id: number; name: string } | null {
  const match = html.match(/data-band="([^"]*)"/);
  if (!match) return null;
  try {
    // The attribute value is HTML-escaped JSON.
    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    const parsed = JSON.parse(decoded) as { id?: unknown; name?: unknown };
    if (typeof parsed.id !== 'number' || typeof parsed.name !== 'string') return null;
    return { id: parsed.id, name: parsed.name };
  } catch {
    return null;
  }
}

/**
 * Releases listed in the sidebar discography of a Bandcamp album or track page.
 *
 * Bandcamp serves two layouts at `<slug>.bandcamp.com/music`. An artist with
 * several releases gets the `.music-grid-item` grid. An artist with a single
 * release gets a 303 to that release, and the album page it lands on has **no
 * grid at all** — the discography lives in a `#discography` sidebar instead:
 *
 *   <div id="discography" class="sidebar">
 *     <li><div class="trackTitle"><a href="/album/…">Subtitles For Blushing</a></div></li>
 *
 * Reading it is what stops a one-release artist from being mistaken for an empty
 * squatter. Measured on 2026-07-26: 5 of 13 `rejected_empty` verdicts were real
 * artists in this layout, Massive Attack and Yoko Kanno among them.
 */
function parseBandcampSidebarDiscography(root: HTMLElement): { href: string; title: string }[] {
  const sidebar = root.querySelector('#discography');
  if (!sidebar) return [];

  const entries: { href: string; title: string }[] = [];
  for (const link of sidebar.querySelectorAll('.trackTitle a')) {
    const href = link.getAttribute('href');
    if (!href) continue;
    entries.push({ href, title: link.textContent?.trim() ?? '' });
  }
  return entries;
}

/**
 * Count releases on a Bandcamp /music page, split by type.
 *
 * Zero albums AND zero tracks is the parked-squatter signature. Accounts at
 * `beyonce`, `sufjan` and `jackwhite` all exist and all return a matching
 * data-band name, but hold no releases — so a name check alone would surface
 * them as genuine artist pages.
 *
 * Handles both page layouts. The sidebar is only consulted when the grid is
 * empty, so a normal discography page behaves exactly as before.
 */
export function parseBandcampReleaseCounts(html: string): { albums: number; tracks: number } {
  const root = parse(html);
  const albums = new Set<string>();
  const tracks = new Set<string>();

  for (const item of root.querySelectorAll('.music-grid-item')) {
    // e.g. data-item-id="album-1507079760" / "track-526682361"
    const id = item.getAttribute('data-item-id');
    if (!id) continue;
    if (id.startsWith('album-')) albums.add(id);
    else if (id.startsWith('track-')) tracks.add(id);
  }

  if (albums.size > 0 || tracks.size > 0) {
    return { albums: albums.size, tracks: tracks.size };
  }

  // No grid. Either a genuinely empty account, or the single-release layout.
  for (const entry of parseBandcampSidebarDiscography(root)) {
    if (entry.href.includes('/album/')) albums.add(entry.href);
    else if (entry.href.includes('/track/')) tracks.add(entry.href);
  }

  return { albums: albums.size, tracks: tracks.size };
}

/**
 * Read the raw location string from a Bandcamp page, e.g. "Northampton, Massachusetts".
 *
 * Artist and /music pages carry this in a `class="location"` element. Returned raw so
 * the caller can run it through parseLocationString — this module stays I/O and
 * dependency free.
 *
 * Worth having because the probe already fetches /music: pulling location from that
 * same response saves a second round trip to a page we have in hand. Measured 89%
 * hit rate (16/18 long-tail artists; both misses have no location in Bandcamp's own
 * discover API either).
 */
export function parseBandcampPageLocation(html: string): string | null {
  const match = html.match(
    /<(?:p|div|span)[^>]+class="[^"]*\blocation\b[^"]*"[^>]*>([^<]+)<\/(?:p|div|span)>/,
  );
  if (!match) return null;
  const raw = match[1].replace(/\s+/g, ' ').trim();
  return raw.length > 0 && raw.length <= 120 ? raw : null;
}

/**
 * Read the artist photo from a Bandcamp page's og:image.
 *
 * Verified band-level rather than album art: radiohead/music yields
 * f4.bcbits.com/img/0040867508_23.jpg, which is exactly the image production already
 * shows for Radiohead. Free — the probe has this HTML in hand.
 *
 * Matters because the artist image has been coming from the Qobuz match, and Qobuz's
 * search path is robots-disallowed and being retired. Bandcamp is the replacement.
 */
export function parseBandcampImage(html: string): string | null {
  const match = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (!match) return null;
  const url = match[1].trim();
  // Bandcamp uses blank.gif as a placeholder; treat it as no image.
  if (!url.startsWith('https://') || url.includes('/blank.gif')) return null;
  return url;
}

/**
 * Parse Bandcamp /music page HTML to extract release titles.
 *
 * Falls back to the sidebar discography for the single-release layout, for the
 * same reason parseBandcampReleaseCounts does — and because a Bandcamp result
 * arriving with no titles forces disambiguation to spend its shared 4s release
 * budget re-fetching a page the probe already read.
 */
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

  if (titles.length > 0) return titles;

  for (const entry of parseBandcampSidebarDiscography(root)) {
    if (entry.title) titles.push(normalizeForComparison(entry.title));
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
