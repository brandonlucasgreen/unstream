/**
 * The release list as the artist has rearranged it on /artist-edit/:slug/releases but not yet
 * saved.
 *
 * An arrangement in progress is held as ids rather than a reordered copy of the list, so the
 * refetch that every other action on that page triggers — hiding a release, fixing a title —
 * can't quietly discard it. That's what this function puts back together.
 *
 * A release the artist hasn't placed (one catalogued since the page loaded) keeps its server
 * position at the end rather than appearing somewhere in the middle of an order it was never
 * part of. Ranks are real numbers for exactly that case: `Infinity - Infinity` is NaN, and a
 * comparator returning NaN leaves the whole list in arbitrary order.
 */
export function applyPendingOrder<T extends { id: string }>(
  releases: T[],
  pendingOrder: string[] | null
): T[] {
  if (!pendingOrder) return releases;
  const rank = new Map(pendingOrder.map((id, index) => [id, index]));
  return releases
    .map((release, index) => ({ release, rank: rank.get(release.id) ?? pendingOrder.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.release);
}
