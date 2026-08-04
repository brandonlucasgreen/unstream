// Artists Unstream will not list, on ethical grounds.
//
// Deliberately separate from api/lib/non-artist-names.ts. That list answers "is this a musical
// act at all?" and its entries are factual — chatgpt.com is OpenAI's, nbc.com is NBC's. This one
// is an editorial decision about acts that genuinely are musicians. Keeping them apart means
// neither list has to be read as the other kind of claim, and a future reviewer can revisit this
// one without reopening the factual list.
//
// Keys are `artistSlug()` output. Removing a line lets the artist back in on the next uncached
// search. Every entry needs a reason recorded here, because "why is this band missing?" is
// otherwise unanswerable.

export const EXCLUDED_ARTIST_SLUGS = new Set([
  // German NSBM band. Identified from the stored Instagram handle `horde_absurd`, which is the
  // band's own; two members were convicted of the 1993 murder of a classmate, and the project's
  // output is explicitly neo-Nazi. Excluded 2026-08-04.
  'absurd',
]);

export function isExcludedArtistSlug(slug: string): boolean {
  return EXCLUDED_ARTIST_SLUGS.has(slug);
}
