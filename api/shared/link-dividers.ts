// Link dividers for claimed artist pages — shared between the edge function and
// API endpoints, because both render the artist page.
//
// A divider is a position in the artist's full ordered link list, stored on
// artist_profiles.link_dividers as "the number of links before it". The artist
// page renders non-social links ("Support directly") and social links ("Follow")
// in separate sections, so a stored position has to be translated into the main
// list before it can be drawn.

/**
 * Translate stored divider positions into indexes in the main (non-social) link
 * list: a returned index N means "draw a divider above main link N".
 *
 * `orderedLinks` must be the artist's full link list in display order, socials
 * included — that's the ordering the stored positions count against.
 *
 * A divider next to a social link falls into the nearest main-list gap rather
 * than disappearing. Leading, trailing, and repeated dividers are dropped: a
 * rule with nothing on one side reads as a rendering bug, not as grouping.
 */
export function mainLinkDividerIndexes<T>(
  orderedLinks: T[],
  isMainLink: (link: T) => boolean,
  positions: number[] | null | undefined
): number[] {
  if (!positions || positions.length === 0) return [];

  const slots = new Set(positions);
  const indexes: number[] = [];
  let mainCount = 0;
  let pending = false;

  for (let i = 0; i < orderedLinks.length; i++) {
    if (slots.has(i)) pending = true;
    if (!isMainLink(orderedLinks[i])) continue;
    if (pending && mainCount > 0) indexes.push(mainCount);
    pending = false;
    mainCount++;
  }

  return indexes;
}

// The editor sends links and dividers as one ordered list, so a divider is
// identified by this platform value rather than by a separate field.
export const DIVIDER_PLATFORM = 'divider';

// Cap dividers per profile. Every gap in a link list is a legitimate divider
// position, so this only rules out a payload that isn't a real link list.
export const MAX_DIVIDERS = 20;

export interface LinkEntry {
  platform: string;
  url?: string;
  displayName?: string;
}

export interface LinkRow {
  platform: string;
  url: string;
  display_name: string | null;
  display_order: number;
}

/**
 * Turn the editor's single ordered list of links and divider markers into the
 * rows to store and the divider positions to store beside them.
 *
 * `entries` must already be validated (real platform, parseable http(s) URL) —
 * this function only handles ordering, so it stays pure and testable.
 *
 * Divider positions count preceding links. Leading (0), trailing (=== link
 * count), and repeated positions are dropped: a rule with nothing on one side
 * reads as a bug rather than as grouping. "other" links get a unique platform
 * id to satisfy artist_links' unique(artist_id, platform).
 */
export function buildLinkRows(entries: LinkEntry[]): { links: LinkRow[]; dividers: number[] } {
  const positions: number[] = [];
  let linksSoFar = 0;
  for (const entry of entries) {
    if (entry.platform !== DIVIDER_PLATFORM) {
      linksSoFar++;
    } else if (linksSoFar > 0 && !positions.includes(linksSoFar)) {
      positions.push(linksSoFar);
    }
  }

  let otherCount = 0;
  const links: LinkRow[] = entries
    .filter(e => e.platform !== DIVIDER_PLATFORM)
    .map((entry, index) => ({
      platform: entry.platform === 'other' ? `other_${otherCount++}` : entry.platform,
      url: entry.url as string,
      display_name: entry.displayName?.trim().slice(0, 50) || null,
      display_order: index,
    }));

  const dividers = positions.filter(p => p < links.length).slice(0, MAX_DIVIDERS);

  return { links, dividers };
}
