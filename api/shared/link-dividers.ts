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
