// Pure paging and sorting logic for the collection grid. Separate from the component so it
// can be unit-tested directly, and so the component file exports only a component.

export interface CollectionGridItem {
  key: string;
  title: string;
  artistName: string;
  artUrl: string | null;
  acquiredAt: string | null;
  /** Release page, when the item matched one. Null renders the title as plain text. */
  releaseUrl: string | null;
  /** Artist page, when that artist exists on Unstream. Null renders the name as plain text. */
  artistUrl: string | null;
  /** Owner view: hidden-from-public items are shown, dimmed. */
  dimmed?: boolean;
  /** Owner view: the per-tile hide/show control. */
  overlay?: React.ReactNode;
}

export type CollectionSortKey = 'added' | 'album' | 'artist';

export const COLLECTION_SORTS: { key: CollectionSortKey; label: string }[] = [
  { key: 'added', label: 'Date added' },
  { key: 'album', label: 'Album name (A–Z)' },
  { key: 'artist', label: 'Artist name (A–Z)' },
];

/**
 * 15 a page, in three rows of five. A real collection is ~190 items, and rendering all of
 * them is both unnavigable and — now that unmatched covers are fetched from Bandcamp on
 * demand — 190 upstream image requests on a single page load.
 */
export const COLLECTION_PAGE_SIZE = 15;

/** How many consecutive page numbers to show around the current one. */
const PAGE_RUN = 5;

/**
 * Page numbers to render, with nulls standing in for gaps: 1 … 5 6 [7] 8 9 … 13
 *
 * The run stays PAGE_RUN wide even at the ends — a window of just current±1 technically
 * paginates but leaves most pages unreachable in one click, which defeats the point of
 * numbering them.
 */
export function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  let start = Math.max(1, current - Math.floor(PAGE_RUN / 2));
  const end = Math.min(total, start + PAGE_RUN - 1);
  start = Math.max(1, end - PAGE_RUN + 1);

  const pages = new Set<number>([1, total]);
  for (let n = start; n <= end; n++) pages.add(n);

  const ordered = [...pages].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0 && ordered[i] - ordered[i - 1] > 1) out.push(null);
    out.push(ordered[i]);
  }
  return out;
}

export function sortItems(
  items: CollectionGridItem[],
  sort: CollectionSortKey
): CollectionGridItem[] {
  const sorted = [...items];
  if (sort === 'album') {
    sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  } else if (sort === 'artist') {
    sorted.sort(
      (a, b) =>
        a.artistName.localeCompare(b.artistName, undefined, { sensitivity: 'base' }) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    );
  } else {
    // Newest acquisition first. Items with no date sort last rather than to the top, where
    // an unknown date would masquerade as the most recent purchase.
    sorted.sort((a, b) => {
      if (!a.acquiredAt && !b.acquiredAt) return 0;
      if (!a.acquiredAt) return 1;
      if (!b.acquiredAt) return -1;
      return b.acquiredAt.localeCompare(a.acquiredAt);
    });
  }
  return sorted;
}
