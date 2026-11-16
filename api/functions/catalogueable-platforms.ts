// Which stored links the catalogue pass can crawl, in one place.
//
// Two things ask this and must agree: the sweep, which picks artists to catalogue (db.ts passes
// the list to `stale_catalog_candidates`), and `catalogArtist`, which records an artist with no
// such link as a failure. They used to hold the list separately with a "keep identical" comment;
// an artist the sweep picks but the pass rejects climbs `consecutive_failures` for nothing.
//
// A pure module on purpose, with no database import: tests that mock `./db` with a fixed list of
// names would otherwise have to stub it too.

/**
 * The platforms `catalogArtist` can actually crawl.
 *
 * Deliberately **not** including `officialsite`: that link is only followed to *discover* other
 * platforms, and `catalogArtist` treats an artist with nothing but an official site as having
 * "no bandcamp, discogs, faircamp, jam.coop, or mirlo link stored" — which it records as an
 * **error**, incrementing `consecutive_failures` and writing `last_error`.
 */
export const CATALOGUEABLE_PLATFORMS = ['bandcamp', 'discogs', 'faircamp', 'jamcoop', 'mirlo'] as const;

/** One `<platform>Url` field per catalogue-able platform, as `getArtistForCatalog` returns them. */
export type CatalogueableLinks = {
  [Platform in (typeof CATALOGUEABLE_PLATFORMS)[number] as `${Platform}Url`]: string | null;
};

/**
 * Whether the catalogue pass has anything to crawl for this artist. Adding a platform to the list
 * without giving the artist a matching `<platform>Url` field doesn't compile.
 */
export function hasCatalogueableLink(artist: CatalogueableLinks): boolean {
  return CATALOGUEABLE_PLATFORMS.some(platform => Boolean(artist[`${platform}Url`]));
}
